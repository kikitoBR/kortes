"""A live session: record, listen, find moments and render them while the stream runs.

  record   ffmpeg copies the stream into pieces of LIVE_PIECE_SECONDS
  listen   each finished piece gives up its audio: voice energy per second and
           a transcription (up to 3 at a time), all on one live clock
  look     every LIVE_ANALYSIS_INTERVAL_SECONDS of new speech, or 45 s after a
           strong voice peak, the AI reads the last 5 minutes and names the
           moments that already ended
  cut      each accepted moment keeps its minutes as an archive file and is
           rendered through the normal pipeline (captions, hook, layout,
           loudness, review), then saved to the task as it is ready

Pieces are deleted a few minutes after the AI has read them, so a stream of
hours never takes more than LIVE_BUFFER_MAX_SECONDS of video on disk.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Tuple

from ..ai import LiveMoments, get_clip_duration_profile, sanitize_hook_title
from ..clip_review import label, parse_label, transcript_excerpt
from ..config import get_config
from ..media.common import TRANSCRIPT_CACHE_SCHEMA_VERSION, WEBCAM_OUTPUT_FORMATS
from ..media.voice_energy import FLOOR_DB, STRONG_PEAK_Z, energy_zscores, measure_levels
from ..utils.async_helpers import run_in_thread
from .archive import LiveClipSource, add_archive_entry, live_dir, read_json, timing_path, write_json
from .capture import (
    LiveStream,
    PieceRecorder,
    extract_piece_audio,
    join_pieces,
    probe_piece,
    recorder_command,
)

logger = logging.getLogger(__name__)

CONTEXT_SECONDS = 300  # transcript the AI reads per look
LOOKBACK_SECONDS = 90  # a moment may have started before the previous look
PEAK_REACTION_SECONDS = 45  # after a strong peak, look once the reaction is in
MIN_LOOK_GAP_SECONDS = 40
FINISHED_MARGIN_SECONDS = 8
ARCHIVE_BEFORE_SECONDS = 20  # room for the review and "começa antes"
ARCHIVE_AFTER_SECONDS = 10
PTS_WRAP_SECONDS = 2**33 / 90000  # MPEG-TS timestamps roll over after ~26.5 h
OVERLAP_TOLERANCE_SECONDS = 3
RECONNECT_ATTEMPTS = 5
PROGRESS_EVERY_SECONDS = 10
TRANSCRIBE_CONCURRENCY = 3


@dataclass
class LiveOptions:
    output_format: str = "vertical"
    add_subtitles: bool = True
    font_family: Optional[str] = None
    font_size: Optional[int] = None
    font_color: Optional[str] = None
    caption_template: str = "default"
    cleanup_settings: Dict[str, Any] = field(default_factory=dict)
    webcam_region: Optional[Dict[str, float]] = None
    hook_intro: Optional[bool] = None
    clip_duration: Optional[str] = "auto"
    max_seconds: int = 4 * 3600


class LiveHooks(Protocol):
    """What the session needs from the outside world (swapped in tests)."""

    async def probe(self) -> Optional[LiveStream]: ...
    def transcribe(self, audio: Path) -> List[Dict[str, Any]]: ...
    async def find_moments(self, prompt: str) -> LiveMoments: ...
    async def render(self, segment: Dict[str, Any], index: int, webcam_region: Optional[Dict[str, float]], voice_energy: List[float]) -> Optional[Dict[str, Any]]: ...
    async def save_clip(self, clip_info: Dict[str, Any], order: int) -> Optional[str]: ...
    async def progress(self, message: str) -> bool: ...
    async def control(self) -> Optional[str]: ...


@dataclass
class Piece:
    path: Path
    audio: Optional[Path]
    start: float
    end: float
    run: str
    transcribed: bool = False


def unwrap_piece_times(
    start: float, audio_start: float, last_start: Optional[float], wrap: float
) -> Tuple[float, float, float]:
    """A piece's start and audio start on a clock that never rolls back.

    Pieces keep the stream's own timestamps (so a YouTube live's separate video
    and audio stay in sync), and MPEG-TS timestamps wrap every ~26.5 h. Returns
    (start, audio_start, wrap so far).
    """
    if last_start is not None and start + wrap < last_start - PTS_WRAP_SECONDS / 2:
        wrap += PTS_WRAP_SECONDS
    start += wrap
    audio_start += wrap
    if audio_start < start - PTS_WRAP_SECONDS / 2:
        audio_start += PTS_WRAP_SECONDS  # the audio crossed the wrap before the picture
    return start, audio_start, wrap


def filter_moments(
    moments: List[Any],
    taken: List[Dict[str, float]],
    *,
    min_score: int,
    finished_before: float,
    newer_than: float,
    min_seconds: float,
    max_seconds: float,
) -> List[Dict[str, Any]]:
    """New, finished, strong moments that do not repeat what was already cut."""
    accepted: List[Dict[str, Any]] = []
    for moment in sorted(moments, key=lambda m: m.score, reverse=True):
        start, end = parse_label(moment.start_time), parse_label(moment.end_time)
        if start is None or end is None or end <= start:
            continue
        if moment.score < min_score or end > finished_before or end <= newer_than:
            continue
        if not min_seconds <= end - start <= max_seconds:
            continue
        candidate = {"start": float(start), "end": float(end), "moment": moment}
        if any(
            candidate["start"] < other["end"] - OVERLAP_TOLERANCE_SECONDS
            and candidate["end"] > other["start"] + OVERLAP_TOLERANCE_SECONDS
            for other in [*taken, *accepted]
        ):
            continue
        accepted.append(candidate)
    return sorted(accepted, key=lambda c: c["start"])


def build_live_prompt(
    title: str, transcript: str, now: float, newer_than: float, already: List[str]
) -> str:
    lines = [
        f"LIVE: {title}. Times count from the start of the recording; recorded and heard up to {label(now)}.",
    ]
    if already:
        lines.append("ALREADY CLIPPED (never repeat): " + "; ".join(already))
    lines += [
        "",
        "TRANSCRIPT (🔊 = volume peak):",
        transcript or "(nothing said)",
        "",
        f"Only moments that have ALREADY ENDED (end_time before {label(now - FINISHED_MARGIN_SECONDS)}) "
        f"and end after {label(newer_than)}. An empty list is a fine answer.",
    ]
    return "\n".join(lines)


class LiveSession:
    def __init__(
        self,
        task_id: str,
        options: LiveOptions,
        hooks: LiveHooks,
        *,
        title: str = "Live",
        realtime: bool = True,
        poll_seconds: float = 2.0,
    ):
        config = get_config()
        self.task_id = task_id
        self.options = options
        self.hooks = hooks
        self.title = title
        self.realtime = realtime
        self.poll_seconds = poll_seconds
        self.piece_seconds = config.live_piece_seconds
        self.buffer_max_seconds = config.live_buffer_max_seconds
        self.interval = config.live_analysis_interval_seconds
        self.min_score = config.live_min_score
        self.max_clips = config.live_max_clips
        profile = get_clip_duration_profile(options.clip_duration)
        self.min_clip_seconds = float(profile["min_accepted"])
        self.max_clip_seconds = float(profile["max_accepted"])
        # A moment ending just after the previous look can start a whole clip
        # length earlier, and its archive takes some seconds before that.
        self.keep_behind = LOOKBACK_SECONDS + self.max_clip_seconds + ARCHIVE_BEFORE_SECONDS + 10

        self.dir = live_dir(task_id)
        self.pieces_dir = self.dir / "pieces"
        self.audio_dir = self.dir / "audio"
        self.archive_dir = self.dir / "archive"
        self.timing_path = timing_path(task_id)
        self.state = read_json(self.dir / "state.json", {})
        self.state.setdefault("clock", 0.0)
        self.state.setdefault("looked_until", 0.0)
        self.state.setdefault("clips", [])
        cache = read_json(self.timing_path.with_suffix(".transcript_cache.json"), {})
        self.words: List[Dict[str, Any]] = cache.get("words") or []
        self.energy: List[float] = cache.get("voice_energy_db") or []
        self.transcribed_until = float(self.state.get("transcribed_until", self.state["clock"]))

        self.pieces: List[Piece] = []
        self.pending: Dict[int, asyncio.Task] = {}
        self.order: List[Piece] = []
        self.recorder: Optional[PieceRecorder] = None
        self.run_offset = 0.0
        self.run_origin: Optional[float] = None
        self.run_last_start: Optional[float] = None
        self.run_wrap = 0.0
        self.ending = False
        self.cancelled = False
        # The user pressed "Parar": no new moments; "stop_now" also drops the queue.
        self.stopped_by_user = False
        self.discard_queue = False
        self.limit_reached = False
        self.reconnects = 0
        self.look_task: Optional[asyncio.Task] = None
        self.last_look_at = self.state["looked_until"]
        self.renders: asyncio.Queue = asyncio.Queue()
        self.render_task: Optional[asyncio.Task] = None
        self.webcam_region = options.webcam_region
        self.webcam_checked = bool(options.webcam_region) or options.output_format not in WEBCAM_OUTPUT_FORMATS
        self.last_progress = 0.0
        self.last_seen = ""
        self.semaphore = asyncio.Semaphore(TRANSCRIBE_CONCURRENCY)

    # ----- state ---------------------------------------------------------------
    def save(self) -> None:
        self.state["transcribed_until"] = self.transcribed_until
        self.state["wall_end"] = time.time()
        write_json(self.dir / "state.json", self.state)

    def save_transcript(self) -> None:
        write_json(
            self.timing_path.with_suffix(".transcript_cache.json"),
            {
                "version": TRANSCRIPT_CACHE_SCHEMA_VERSION,
                "words": self.words,
                "utterances": [],
                "text": "",
                "language_code": None,
                "source_duration": max(self.state["clock"], 1.0),
                "voice_energy_db": self.energy,
            },
        )

    @property
    def ready_clips(self) -> int:
        return sum(1 for c in self.state["clips"] if c.get("status") == "ready")

    # ----- recording -------------------------------------------------------------
    async def connect(self) -> bool:
        stream = await self.hooks.probe()
        if not stream or not stream.is_live or not stream.inputs:
            return False
        if stream.title:
            self.title = stream.title
        prefix = f"r{uuid.uuid4().hex[:6]}_"
        # A new run continues the clock: after a reconnect (or a worker
        # restart) the time the stream was not recorded is skipped, not reused.
        gap = max(0.0, time.time() - float(self.state.get("wall_end") or time.time()))
        self.run_offset = float(self.state["clock"]) + (gap if self.state["clock"] else 0.0)
        self.run_origin = None
        self.run_last_start = None
        self.run_wrap = 0.0
        self.recorder = PieceRecorder(
            recorder_command(stream.inputs, self.pieces_dir, prefix, self.piece_seconds, realtime=self.realtime),
            self.pieces_dir,
            prefix,
        )
        await self.recorder.start()
        logger.info("Live %s: recording run %s from %.0fs", self.task_id, prefix, self.run_offset)
        return True

    async def stop_recording(self) -> None:
        if self.recorder:
            await self.recorder.stop()

    async def take_closed_pieces(self) -> None:
        if not self.recorder:
            return
        known = {p.path for p in self.order}
        for path in self.recorder.closed_pieces():
            if path in known:
                continue
            await self.add_piece(path)

    async def add_piece(self, path: Path) -> None:
        info = await run_in_thread(probe_piece, path)
        info["start"], info["audio_start"], self.run_wrap = unwrap_piece_times(
            info["start"], info["audio_start"], self.run_last_start, self.run_wrap
        )
        self.run_last_start = info["start"]
        if self.run_origin is None:
            self.run_origin = info["start"]
        start = self.run_offset + info["start"] - self.run_origin
        end = start + info["duration"]
        audio = self.audio_dir / f"{path.stem}.m4a"
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        has_audio = info["has_audio"] and await run_in_thread(extract_piece_audio, path, audio)
        piece = Piece(path, audio if has_audio else None, start, end, self.recorder.prefix)
        self.order.append(piece)
        self.pieces.append(piece)
        audio_start = self.run_offset + info["audio_start"] - self.run_origin
        if has_audio:
            levels = await run_in_thread(measure_levels, audio)
            first = max(0, int(math.floor(audio_start)))
            if len(self.energy) < first:
                self.energy.extend([FLOOR_DB] * (first - len(self.energy)))
            for offset, value in enumerate(levels):
                second = first + offset
                if second < len(self.energy):
                    self.energy[second] = value
                else:
                    self.energy.append(value)
        self.state["clock"] = max(float(self.state["clock"]), end)
        index = len(self.order) - 1
        self.pending[index] = asyncio.create_task(self.transcribe(piece, audio_start))
        if self.state["clock"] >= self.options.max_seconds and not self.ending:
            self.limit_reached = True
            await self.finish_recording()

    async def transcribe(self, piece: Piece, audio_start: float) -> List[Dict[str, Any]]:
        if not piece.audio:
            return []
        async with self.semaphore:
            try:
                words = await run_in_thread(self.hooks.transcribe, piece.audio)
            except Exception as exc:
                logger.warning("Live %s: transcription of %s failed: %s", self.task_id, piece.path.name, exc)
                return []
        shift = int(round(audio_start * 1000))
        return [{**w, "start": int(w["start"]) + shift, "end": int(w["end"]) + shift} for w in words]

    async def collect_transcripts(self) -> bool:
        """Append finished transcriptions in order; True when new speech came in."""
        changed = False
        index = next((i for i, p in enumerate(self.order) if not p.transcribed), None)
        while index is not None and index in self.pending and self.pending[index].done():
            piece = self.order[index]
            self.words.extend(self.pending.pop(index).result())
            piece.transcribed = True
            self.transcribed_until = max(self.transcribed_until, piece.end)
            changed = True
            index = index + 1 if index + 1 < len(self.order) and not self.order[index + 1].transcribed else None
        if changed:
            self.words.sort(key=lambda w: w["start"])
            await run_in_thread(self.save_transcript)
            self.save()
        return changed

    def trim_buffer(self) -> None:
        keep_from = float(self.state["looked_until"]) - self.keep_behind
        for piece in list(self.pieces):
            if piece.transcribed and piece.end < keep_from:
                self.drop(piece)
        # Hard cap: never more than the buffer allows, read or not (its audio
        # was already taken, so the transcription still happens).
        while sum(p.end - p.start for p in self.pieces) > self.buffer_max_seconds and self.pieces:
            logger.warning("Live %s: buffer full, dropping a piece the AI has not read yet", self.task_id)
            self.drop(self.pieces[0])

    def drop(self, piece: Piece) -> None:
        piece.path.unlink(missing_ok=True)
        if piece in self.pieces:
            self.pieces.remove(piece)

    # ----- finding moments --------------------------------------------------------
    def zscores(self) -> List[float]:
        return energy_zscores(self.energy) if self.energy else []

    def look_due(self) -> bool:
        if self.look_task and not self.look_task.done():
            return False
        if self.transcribed_until - float(self.state["looked_until"]) >= self.interval:
            return True
        if self.transcribed_until - self.last_look_at < MIN_LOOK_GAP_SECONDS:
            return False
        z = self.zscores()
        first = int(float(self.state["looked_until"]))
        last = int(self.transcribed_until - PEAK_REACTION_SECONDS)
        return any(z[s] >= STRONG_PEAK_Z for s in range(max(0, first), min(len(z), last)))

    def start_look(self) -> None:
        self.last_look_at = self.transcribed_until
        self.look_task = asyncio.create_task(self.look())

    async def look(self) -> None:
        now = self.transcribed_until
        newer_than = max(0.0, float(self.state["looked_until"]) - LOOKBACK_SECONDS)
        since = max(0.0, now - CONTEXT_SECONDS)
        z = self.zscores()
        transcript = await run_in_thread(transcript_excerpt, self.timing_path, since, now, z)
        already = [
            f'{label(c["start"])}-{label(c["end"])} "{c.get("title") or ""}"'
            for c in self.state["clips"]
            if c["end"] > since
        ]
        try:
            found = await self.hooks.find_moments(build_live_prompt(self.title, transcript, now, newer_than, already))
        except Exception as exc:
            logger.warning("Live %s: the AI could not read the last minutes: %s", self.task_id, type(exc).__name__)
            return
        for moment in found.moments:
            logger.info("Live %s: AI saw %s-%s score %s", self.task_id, moment.start_time, moment.end_time, moment.score)
        if found.moments:
            best = max(found.moments, key=lambda m: m.score)
            self.last_seen = f"{best.start_time}–{best.end_time} nota {best.score}"
        accepted = filter_moments(
            found.moments,
            self.state["clips"],
            min_score=self.min_score,
            finished_before=now - 4,
            newer_than=newer_than,
            min_seconds=self.min_clip_seconds,
            max_seconds=self.max_clip_seconds,
        )
        for candidate in accepted:
            if len(self.state["clips"]) >= self.max_clips:
                logger.info("Live %s: reached %d clips", self.task_id, self.max_clips)
                break
            await self.accept(candidate)
        # Only now may the buffer let go of what this look read.
        self.state["looked_until"] = max(float(self.state["looked_until"]), now)
        self.save()

    async def accept(self, candidate: Dict[str, Any]) -> None:
        moment = candidate["moment"]
        number = len(self.state["clips"]) + 1
        start, end = candidate["start"], candidate["end"]
        run = next((p.run for p in self.order if p.start <= start < p.end), None)
        pieces = [
            p for p in self.pieces
            if p.run == run and p.end > start - ARCHIVE_BEFORE_SECONDS and p.start < end + ARCHIVE_AFTER_SECONDS
        ]
        record = {
            "n": number, "start": start, "end": end, "score": moment.score,
            "title": sanitize_hook_title(moment.hook_title) or "", "status": "queued",
        }
        self.state["clips"].append(record)
        if not pieces or pieces[0].start > start or pieces[-1].end < end:
            record["status"] = "missed"
            logger.warning("Live %s: the minutes of moment %d are gone; skipping it", self.task_id, number)
            return
        archive = self.archive_dir / f"clip-{number:03d}.mkv"
        if not await run_in_thread(join_pieces, [p.path for p in pieces], archive):
            record["status"] = "failed"
            return
        add_archive_entry(self.task_id, archive, pieces[0].start, pieces[-1].end)
        hook_start, hook_end = parse_label(moment.hook_start_time), parse_label(moment.hook_end_time)
        teaser = hook_start is not None and hook_end is not None and start <= hook_start < hook_end <= end
        segment = {
            "start_time": label(start),
            "end_time": label(end),
            "text": "",
            "relevance_score": moment.score / 10,
            "reasoning": f"Ao vivo: {moment.reason}".strip(),
            "virality_score": moment.score * 10,
            "hook_score": 0,
            "engagement_score": 0,
            "value_score": 0,
            "shareability_score": 0,
            "hook_type": "live",
            "hook_title": record["title"] or None,
            "hook_start_time": label(hook_start) if teaser else None,
            "hook_end_time": label(hook_end) if teaser else None,
        }
        logger.info("Live %s: moment %d %s-%s (score %d) queued", self.task_id, number, segment["start_time"], segment["end_time"], moment.score)
        await self.renders.put((record, segment, archive))

    # ----- rendering ------------------------------------------------------------------
    async def render_loop(self) -> None:
        while True:
            item = await self.renders.get()
            if item is None:
                return
            record, segment, archive = item
            if self.cancelled or self.discard_queue or record.get("status") == "cancelled":
                record["status"] = "cancelled"
                self.save()
                continue
            record["status"] = "rendering"
            await self.report(force=True)
            started = getattr(self.hooks, "clip_started", None)
            if started:
                try:
                    await started(record["n"] - 1, segment)
                except Exception:
                    logger.debug("Assembly show event failed", exc_info=True)
            try:
                if not self.webcam_checked:
                    self.webcam_checked = True
                    self.webcam_region = await run_in_thread(detect_live_webcam, archive)
                info = await self.hooks.render(segment, record["n"] - 1, self.webcam_region, self.zscores())
                if info and not self.cancelled:
                    await self.hooks.save_clip(info, record["n"])
                    record["status"] = "ready"
                else:
                    record["status"] = "failed"
            except Exception as exc:
                logger.error("Live %s: clip %d failed: %s", self.task_id, record["n"], exc, exc_info=True)
                record["status"] = "failed"
            self.save()
            await self.report(force=True)

    # ----- progress and control --------------------------------------------------------
    def message(self) -> str:
        minutes = int(float(self.state["clock"]) // 60)
        if self.stopped_by_user:
            head = "Gravação parada · terminando o que já estava em montagem"
        elif self.ending:
            head = "A live acabou. Montando os últimos cortes..."
            if self.limit_reached:
                head = "Chegamos ao limite de duração do seu plano. Montando os últimos cortes..."
        else:
            head = f"Ao vivo · gravando há {minutes} min"
        parts = [head, f"{self.ready_clips} {'corte' if self.ready_clips == 1 else 'cortes'}"]
        rendering = sum(1 for c in self.state["clips"] if c.get("status") in {"queued", "rendering"})
        if rendering:
            parts.append(f"{rendering} em montagem")
        if self.last_seen and not self.ending:
            parts.append(f"IA viu {self.last_seen}")
        return " · ".join(parts)

    def queue_for_show(self) -> List[Dict[str, Any]]:
        names = {"queued": "na fila", "rendering": "montando", "ready": "pronto", "failed": "falhou", "missed": "perdido", "cancelled": "cancelado"}
        return [
            {"n": c["n"], "start": label(c["start"]), "end": label(c["end"]), "title": c.get("title"), "status": names.get(c.get("status"), c.get("status"))}
            for c in self.state["clips"]
        ]

    async def report(self, force: bool = False) -> None:
        if not force and time.time() - self.last_progress < PROGRESS_EVERY_SECONDS:
            return
        self.last_progress = time.time()
        show_queue = getattr(self.hooks, "show_queue", None)
        if show_queue:
            try:
                await show_queue(self.queue_for_show())
            except Exception:
                logger.debug("Show queue update failed", exc_info=True)
        if not await self.hooks.progress(self.message()):
            self.cancelled = True

    async def finish_recording(self) -> None:
        self.ending = True
        await self.stop_recording()

    async def check_control(self) -> None:
        action = await self.hooks.control()
        if action == "cancel":
            self.cancelled = True
        elif action in {"stop", "stop_now"} and not self.stopped_by_user:
            logger.info("Live %s: stopped by the user (%s)", self.task_id, action)
            self.stopped_by_user = True
            if action == "stop_now":
                self.discard_queue = True
                for record in self.state["clips"]:
                    if record.get("status") == "queued":
                        record["status"] = "cancelled"
            if self.look_task and not self.look_task.done():
                self.look_task.cancel()
            await self.finish_recording()
            self.save()
            await self.report(force=True)
        if self.cancelled:
            await self.stop_recording()

    # ----- main loop ----------------------------------------------------------------------
    async def run(self) -> Dict[str, Any]:
        self.dir.mkdir(parents=True, exist_ok=True)
        # Pieces of an earlier run have no usable clock; the archive keeps
        # whatever was cut from them.
        for leftover in self.pieces_dir.glob("*.ts"):
            leftover.unlink(missing_ok=True)
        if not await self.connect():
            self.state["finished"] = True
            self.save()
            return {"status": "not_live", "clips": self.ready_clips}
        self.render_task = asyncio.create_task(self.render_loop())
        try:
            while not self.cancelled:
                await self.check_control()
                if self.cancelled:
                    break
                await self.take_closed_pieces()
                if await self.collect_transcripts() and self.look_due():
                    self.start_look()
                self.trim_buffer()
                await self.report()
                if self.recorder and not self.recorder.running and not self.ending:
                    await self.take_closed_pieces()
                    self.reconnects += 1
                    if self.reconnects > RECONNECT_ATTEMPTS or not await self.connect():
                        logger.info("Live %s: the stream is over", self.task_id)
                        self.ending = True
                if self.ending and not (self.recorder and self.recorder.running):
                    # After "Parar" nothing new is looked at: no need to wait
                    # for the last pieces' transcriptions.
                    if self.stopped_by_user:
                        break
                    await self.take_closed_pieces()
                    if not self.pending:
                        break
                await asyncio.sleep(self.poll_seconds)
            if not self.cancelled and not self.stopped_by_user:
                await self.collect_transcripts()
                if self.look_task:
                    await self.look_task
                if self.transcribed_until - float(self.state["looked_until"]) > 20:
                    self.start_look()
                    await self.look_task
        finally:
            await self.stop_recording()
            for task in self.pending.values():
                task.cancel()
            await self.renders.put(None)
            if self.render_task:
                if self.cancelled:
                    self.render_task.cancel()
                await asyncio.gather(self.render_task, return_exceptions=True)
            for record in self.state["clips"]:
                if record.get("status") in {"queued", "rendering"}:
                    record["status"] = "cancelled"
            await self.report(force=True)
            for piece in list(self.pieces):
                self.drop(piece)
            self.state["finished"] = True
            self.save()
        return {
            "status": "cancelled" if self.cancelled else "completed",
            "clips": self.ready_clips,
            "recorded_seconds": round(float(self.state["clock"])),
            "limit_reached": self.limit_reached,
        }


def detect_live_webcam(archive: Path) -> Optional[Dict[str, float]]:
    """The streamer's webcam, found once per live on the first clip's minutes."""
    from ..media.ffmpeg import ffprobe_video_size
    from ..media.webcam_detection import detect_webcam_box

    try:
        found = detect_webcam_box(archive)
        if not found or found.get("kind") == "full" or not found.get("box"):
            return None
        width, height = ffprobe_video_size(archive)
        x, y, w, h = found["box"]
        region: Dict[str, Any] = {"x": x / width, "y": y / height, "w": w / width, "h": h / height}
        if found.get("face"):
            # So every clip of the live centres the same face without looking again.
            fx, fy, fw, fh = found["face"]
            region["face"] = {"x": fx / width, "y": fy / height, "w": fw / width, "h": fh / height}
        return region
    except Exception as exc:
        logger.warning("Live webcam detection failed: %s", exc)
        return None
