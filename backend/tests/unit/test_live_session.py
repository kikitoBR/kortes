"""A live played from a local file, clipped while it "streams"."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from src.ai import LiveMoment, LiveMoments
from src.config import Config, set_config_override
from src.live.archive import archive_covering, live_dir, purge_expired_live_archives, write_json
from src.live.capture import LiveStream, live_platform
from src.live.session import LiveOptions, LiveSession, filter_moments

FLASH_AT = 60.0  # white flash + loud burst in the "stream"


@pytest.fixture
def config(tmp_path):
    cfg = Config()
    cfg.temp_dir = str(tmp_path / "temp")
    cfg.live_piece_seconds = 10
    cfg.live_analysis_interval_seconds = 30
    cfg.live_min_score = 6
    cfg.clip_review_enabled = False
    set_config_override(cfg)
    yield cfg
    set_config_override(None)


@pytest.fixture(scope="module")
def stream_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("stream") / "live.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=120",
            "-f", "lavfi", "-i", f"aevalsrc='if(between(t,{FLASH_AT},{FLASH_AT + 3}),0.9,0.05)*sin(2*PI*440*t)':s=48000:d=120",
            "-vf", f"drawbox=t=fill:color=white:enable='between(t,{FLASH_AT},{FLASH_AT + 0.25})'",
            "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path),
        ],
        check=True, capture_output=True,
    )
    return path


class FakeHooks:
    def __init__(self, stream_file):
        self.stream_file = stream_file
        self.probes = 0
        self.prompts = []
        self.rendered = []
        self.saved = []
        self.messages = []

    async def probe(self):
        self.probes += 1
        live = self.probes == 1  # the stream "ends" when the file does
        return LiveStream("Live de teste", live, [{"url": str(self.stream_file)}] if live else [])

    def transcribe(self, audio):
        duration = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio)],
            capture_output=True, text=True,
        ).stdout or 0)
        return [{"text": f"palavra{i}.", "start": i * 1000, "end": i * 1000 + 600} for i in range(int(duration))]

    async def find_moments(self, prompt):
        self.prompts.append(prompt)
        now = re.search(r"heard up to (\d+):(\d+)", prompt)
        heard = int(now.group(1)) * 60 + int(now.group(2))
        if heard >= 90 and "01:00" not in prompt.split("ALREADY CLIPPED")[-1].split("TRANSCRIPT")[0]:
            return LiveMoments(moments=[
                LiveMoment(start_time="00:55", end_time="01:20", hook_title="Que susto!", score=8, reason="grito"),
                LiveMoment(start_time="00:10", end_time="00:30", hook_title="Morno", score=4, reason="morno"),
            ])
        return LiveMoments()

    async def render(self, segment, index, webcam_region, voice_energy):
        from src.live.archive import LiveClipSource, timing_path
        from src.services.video_service import VideoService

        self.rendered.append(segment)
        output = Path(self.stream_file).parent / "clips"
        output.mkdir(exist_ok=True)
        return await VideoService.create_single_clip(
            timing_path(self.task_id), segment, index, output, None, None, None, "default",
            "original", False, {}, clip_source=LiveClipSource(self.task_id),
        )

    async def save_clip(self, info, order):
        self.saved.append((info, order))
        return f"clip-{order}"

    async def progress(self, message):
        self.messages.append(message)
        return True

    async def control(self):
        return None


def first_flash(path: Path) -> float:
    frames = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout
    means = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 32 * 18).mean(axis=1)
    return float(np.argmax(means > 200)) / 24


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
@pytest.mark.asyncio
async def test_a_live_is_clipped_while_it_streams(config, stream_file):
    hooks = FakeHooks(stream_file)
    hooks.task_id = "task-live"
    options = LiveOptions(output_format="original", add_subtitles=False, max_seconds=3600)
    session = LiveSession("task-live", options, hooks, realtime=False, poll_seconds=0.1)

    result = await session.run()

    assert result["status"] == "completed" and result["clips"] == 1
    assert 115 <= result["recorded_seconds"] <= 125
    # Only the strong moment became a clip, at the order it was found.
    assert [s["hook_title"] for s in hooks.rendered] == ["Que susto!"]
    info, order = hooks.saved[0]
    assert order == 1 and Path(info["path"]).exists()
    # The clip starts on the first word from 00:55 of the live; the flash at
    # 60 s of the stream lands exactly that far into the clip.
    clip_start = info["keep_ranges"][0][0]
    assert 55 <= clip_start < 57
    assert first_flash(Path(info["path"])) == pytest.approx(FLASH_AT - clip_start, abs=0.06)
    # The stream's video is gone; only the clip's minutes stay, for edits.
    folder = live_dir("task-live")
    assert not list((folder / "pieces").glob("*.ts"))
    assert archive_covering("task-live", 50, 85) is not None
    assert len(list((folder / "archive").glob("*.mkv"))) == 1
    cache = json.loads((folder / "live.transcript_cache.json").read_text())
    assert len(cache["words"]) > 100 and cache["source_duration"] > 110
    # The loud burst is on the live clock and marked for the AI.
    assert any("🔊" in p for p in hooks.prompts)
    assert any("Ao vivo" in m for m in hooks.messages)


def test_prompt_lists_what_was_already_clipped():
    from src.live.session import build_live_prompt

    prompt = build_live_prompt("Live", "[01:00 - 01:05] CORRE 🔊🔊", 130, 40, ['00:55-01:20 "Que susto!"'])
    assert 'ALREADY CLIPPED (never repeat): 00:55-01:20 "Que susto!"' in prompt
    assert "end_time before 02:02" in prompt and "end after 00:40" in prompt


def test_only_strong_finished_new_moments_are_taken():
    moments = [
        LiveMoment(start_time="01:00", end_time="01:40", score=8, reason=""),
        LiveMoment(start_time="01:10", end_time="01:50", score=7, reason=""),  # overlaps the first
        LiveMoment(start_time="02:00", end_time="02:30", score=5, reason=""),  # too weak
        LiveMoment(start_time="03:00", end_time="03:59", score=9, reason=""),  # not over yet
        LiveMoment(start_time="00:10", end_time="00:20", score=9, reason=""),  # already read
    ]
    taken = filter_moments(
        moments, [], min_score=6, finished_before=200, newer_than=30, min_seconds=15, max_seconds=135
    )
    assert [(t["start"], t["end"]) for t in taken] == [(60.0, 100.0)]
    again = filter_moments(
        moments[:1], [{"start": 58.0, "end": 101.0}], min_score=6, finished_before=200,
        newer_than=30, min_seconds=15, max_seconds=135,
    )
    assert again == []


def test_buffer_lets_go_of_read_pieces_and_never_grows_past_the_cap(config, tmp_path):
    from src.live.session import Piece

    session = LiveSession("task-buffer", LiveOptions(), FakeHooks(tmp_path))
    session.pieces_dir.mkdir(parents=True)
    for i in range(80):
        path = session.pieces_dir / f"p{i:03d}.ts"
        path.write_bytes(b"x")
        session.pieces.append(Piece(path, None, i * 30.0, i * 30.0 + 30, "r", transcribed=True))
    session.state["looked_until"] = 1200.0
    session.trim_buffer()
    # Kept: what a moment found after the last look could still need.
    assert min(p.start for p in session.pieces) >= 1200 - session.keep_behind - 30
    assert sum(p.end - p.start for p in session.pieces) <= config.live_buffer_max_seconds
    assert len(list(session.pieces_dir.glob("*.ts"))) == len(session.pieces)


def test_live_links_and_archive_expiry(config, tmp_path):
    assert live_platform("https://www.twitch.tv/gaules") == "twitch"
    assert live_platform("https://kick.com/someone") == "kick"
    assert live_platform("https://www.youtube.com/watch?v=abc123DEF45") == "youtube"
    assert live_platform("https://example.com/video.mp4") is None

    folder = live_dir("old-live")
    folder.mkdir(parents=True)
    write_json(folder / "state.json", {"finished": True})
    running = live_dir("running-live")
    running.mkdir(parents=True)
    write_json(running / "state.json", {"finished": False})
    import time

    assert purge_expired_live_archives(now=time.time() + 30 * 86400) == 1
    assert not folder.exists() and running.exists()


def test_edits_reach_only_the_minutes_kept_around_a_clip(config):
    from src.live.archive import LiveClipSource, add_archive_entry

    archive = live_dir("task-win") / "archive"
    archive.mkdir(parents=True)
    for name in ("clip-001.mkv", "clip-002.mkv"):
        (archive / name).write_bytes(b"x")
    add_archive_entry("task-win", archive / "clip-001.mkv", 130.0, 205.0)
    add_archive_entry("task-win", archive / "clip-002.mkv", 400.0, 470.0)
    source = LiveClipSource("task-win")
    assert source.window(150, 195) == (130.0, 205.0)
    # An edit already reaching past the kept minutes still finds them.
    assert source.window(146, 241) == (130.0, 205.0)
    assert source.window(300, 350) is None


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
@pytest.mark.asyncio
async def test_stop_ends_the_recording_and_keeps_what_was_heard(config, stream_file):
    import time

    class StoppingHooks(FakeHooks):
        started = None

        async def control(self):
            self.started = self.started or time.monotonic()
            return "stop" if time.monotonic() - self.started > 25 else None

    hooks = StoppingHooks(stream_file)
    hooks.task_id = "task-stop"
    session = LiveSession("task-stop", LiveOptions(output_format="original", add_subtitles=False), hooks, poll_seconds=0.5)
    started = time.monotonic()
    result = await session.run()

    # Played in real time and stopped after ~25 s, long before the 2-minute stream ends.
    assert time.monotonic() - started < 60
    assert result["status"] == "completed"
    assert 15 <= result["recorded_seconds"] <= 40
    assert hooks.probes == 1  # a stop is not a dropped stream: no reconnect
    assert not list((live_dir("task-stop") / "pieces").glob("*.ts"))
    assert any("Ao vivo · gravando há" in m for m in hooks.messages)


@pytest.mark.asyncio
async def test_stop_now_drops_the_queue_and_says_so(config, tmp_path):
    class Hooks(FakeHooks):
        async def control(self):
            return "stop_now"

    hooks = Hooks(tmp_path)
    session = LiveSession("task-now", LiveOptions(), hooks)
    session.state["clips"] = [
        {"n": 1, "start": 10.0, "end": 40.0, "status": "ready"},
        {"n": 2, "start": 50.0, "end": 80.0, "status": "rendering"},
        {"n": 3, "start": 90.0, "end": 120.0, "status": "queued"},
    ]
    await session.check_control()

    assert session.stopped_by_user and session.discard_queue and session.ending
    assert [c["status"] for c in session.state["clips"]] == ["ready", "rendering", "cancelled"]
    assert hooks.messages[-1].startswith("Gravação parada")
    # A queued moment still in the render queue is skipped, not rendered.
    record = {"n": 4, "start": 0, "end": 1, "status": "queued"}
    await session.renders.put((record, {}, tmp_path / "a.mkv"))
    await session.renders.put(None)
    await session.render_loop()
    assert record["status"] == "cancelled" and not hooks.rendered


def test_pieces_keep_one_clock_past_the_mpegts_wrap():
    from src.live.session import PTS_WRAP_SECONDS, unwrap_piece_times

    start, audio, wrap = unwrap_piece_times(95400.0, 95401.5, None, 0.0)
    assert (start, audio, wrap) == (95400.0, 95401.5, 0.0)
    # The next piece rolled over: it still comes 30 s later.
    start, audio, wrap = unwrap_piece_times(95430.0 - PTS_WRAP_SECONDS, 95431.5 - PTS_WRAP_SECONDS, 95400.0, wrap)
    assert round(start, 3) == 95430.0 and round(audio, 3) == 95431.5 and wrap == PTS_WRAP_SECONDS
    # Picture just before the wrap, voice just after it.
    start, audio, _ = unwrap_piece_times(95443.0, 0.5, 95400.0, 0.0)
    assert round(audio - start, 3) == round(0.5 + PTS_WRAP_SECONDS - 95443.0, 3)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_separate_video_and_audio_streams_stay_in_sync(tmp_path):
    """A YouTube live's video and audio open at different points of the stream."""
    from src.live.capture import probe_piece, recorder_command

    video, audio = tmp_path / "v.ts", tmp_path / "a.ts"
    # Same stream clock; the audio playlist was opened 2 s later than the video one.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=12",
                    "-c:v", "libx264", "-preset", "ultrafast", "-output_ts_offset", "100", "-f", "mpegts", str(video)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-c:a", "aac", "-output_ts_offset", "102", "-f", "mpegts", str(audio)], check=True)
    pieces = tmp_path / "pieces"
    pieces.mkdir()
    command = recorder_command([{"url": str(video)}, {"url": str(audio)}], pieces, "r_", 6, realtime=False)
    assert "-copyts" in command and command.index("-copyts") < command.index(str(pieces / "r_%06d.ts"))
    subprocess.run(command, check=True, capture_output=True, timeout=60)
    first = probe_piece(sorted(pieces.glob("r_*.ts"))[0])
    # The voice starts 2 s after the picture, as on the stream (not both at 0).
    assert abs((first["audio_start"] - first["start"]) - 2.0) < 0.1



@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
@pytest.mark.asyncio
async def test_a_free_live_cuts_its_first_moments_as_they_happen_then_stops(config, stream_file):
    class Hooks(FakeHooks):
        async def find_moments(self, prompt):
            self.prompts.append(prompt)
            now = re.search(r"heard up to (\d+):(\d+)", prompt)
            heard = int(now.group(1)) * 60 + int(now.group(2))
            moments = []
            if heard >= 40 and "00:05" not in prompt.split("ALREADY CLIPPED")[-1].split("TRANSCRIPT")[0]:
                moments.append(LiveMoment(start_time="00:05", end_time="00:25", hook_title="Bom", score=7, reason="bom"))
            if heard >= 90:
                moments.append(LiveMoment(start_time="00:55", end_time="01:20", hook_title="Que susto!", score=9, reason="grito"))
            return LiveMoments(moments=moments)

    hooks = Hooks(stream_file)
    hooks.task_id = "task-free-live"
    options = LiveOptions(output_format="original", add_subtitles=False, max_seconds=3600, max_clips=1, watermark=True)
    session = LiveSession("task-free-live", options, hooks, realtime=False, poll_seconds=0.1)

    result = await session.run()

    # In order, as they happen: the first strong moment takes the plan's cut,
    # not the stronger one that comes later.
    assert result["status"] == "completed" and result["clips"] == 1
    assert [s["hook_title"] for s in hooks.rendered] == ["Bom"]
    assert [c["title"] for c in session.state["clips"]] == ["Bom"]


def test_a_free_live_says_its_limit_and_stops_once_it_is_spent(config, tmp_path):
    session = LiveSession("task-free-msg", LiveOptions(max_clips=5, watermark=True), FakeHooks(tmp_path))
    assert session.max_clips == 5
    assert "plano grátis: até 5 cortes" in session.message()
    session.plan_limit_reached = session.ending = True
    assert session.message().startswith("Seus 5 cortes grátis desta live")
