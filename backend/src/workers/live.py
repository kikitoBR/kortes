"""Live worker: one long job per live stream, on its own queue.

Runs as its own service (docker-compose "live-worker"), so a stream of hours
never takes one of the render worker's slots. Recording is a stream copy; the
heavy part (rendering each clip) happens here one clip at a time.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from arq import Retry
from arq.worker import func

from ..config import Config, env_or_default, get_config
from ..observability import configure_logging, set_trace_id
from ..utils.async_helpers import run_in_thread

configure_logging()
logger = logging.getLogger(__name__)

LIVE_QUEUE_NAME = "supoclip_live"
LIVE_MAX_TRIES = 5


def transcribe_live_audio(audio: Path, processing_mode: str = "fast") -> List[Dict[str, Any]]:
    """Words (ms, relative to the piece) of one piece of the live's audio."""
    from ..media.transcription import (
        _get_transcript_with_assemblyai,
        _get_transcript_with_whisper,
        load_cached_transcript_data,
    )

    config = get_config()
    whisper_fallback = config.transcription_fallback == "whisper"
    if config.transcription_provider == "whisper" or (whisper_fallback and not config.assembly_ai_api_key):
        _get_transcript_with_whisper(audio, config)
    else:
        # YouTube captions do not exist for a stream in progress.
        model = config.fast_mode_transcript_model if processing_mode == "fast" else "best"
        try:
            _get_transcript_with_assemblyai(audio, model, config)
        except Exception:
            if not whisper_fallback:
                raise
            # Kortes Desktop: the customer's AssemblyAI key failed; Whisper on this PC.
            _get_transcript_with_whisper(audio, config)
    words = (load_cached_transcript_data(audio) or {}).get("words") or []
    audio.with_suffix(".transcript_cache.json").unlink(missing_ok=True)
    audio.with_name(f"{audio.stem}.transcription.mp3").unlink(missing_ok=True)
    return words


class ProductionLiveHooks:
    """The live session's link to yt-dlp, the AI, the renderer, the DB and Redis."""

    def __init__(self, ctx: Dict[str, Any], task_id: str, url: str, options, processing_mode: str):
        from ..show import ShowReporter
        from ..workers.progress import ProgressTracker

        self.redis = ctx["redis"]
        self.task_id = task_id
        self.url = url
        self.options = options
        self.processing_mode = processing_mode
        self.tracker = ProgressTracker(ctx["redis"], task_id)
        self.show = ShowReporter(ctx["redis"], task_id)

    async def probe(self):
        from ..live.capture import probe_live

        try:
            return await run_in_thread(probe_live, self.url)
        except Exception as exc:
            logger.warning("Live %s: could not open the stream: %s", self.task_id, exc)
            return None

    def transcribe(self, audio: Path) -> List[Dict[str, Any]]:
        return transcribe_live_audio(audio, self.processing_mode)

    async def find_moments(self, prompt: str):
        from ..ai import find_live_moments

        return await find_live_moments(prompt)

    async def render(self, segment, index, webcam_region, voice_energy):
        from ..clip_cleanup import normalize_clip_cleanup_settings
        from ..live.archive import LiveClipSource, timing_path
        from ..services.task_service import TaskService, add_review_note
        from ..services.video_service import VideoService

        config = get_config()
        output_dir = Path(config.temp_dir) / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        clip_source = LiveClipSource(self.task_id)
        timing = timing_path(self.task_id)
        render_options = (
            self.options.font_family,
            self.options.font_size,
            self.options.font_color,
            self.options.caption_template,
            self.options.output_format,
            self.options.add_subtitles,
            normalize_clip_cleanup_settings(**(self.options.cleanup_settings or {})),
        )
        # The review reads only the transcript, so its fixes go into the one render.
        note = None
        if config.clip_review_enabled:
            await self.show.clip(stage="revisao")
            segment, note = await TaskService(db=None)._review_segment(
                timing, segment, index,
                hook_intro=self.options.hook_intro, voice_energy=voice_energy, show=self.show,
            )
        info = await VideoService.create_single_clip(
            timing, segment, index, output_dir, *render_options,
            webcam_region=webcam_region, hook_intro=self.options.hook_intro, clip_source=clip_source,
            show=self.show,
        )
        add_review_note(info, note)
        return info

    async def clip_started(self, index: int, segment: Dict[str, Any]) -> None:
        await self.show.start_clip(index, 0, segment, self.options.output_format)

    async def show_queue(self, items: List[Dict[str, Any]]) -> None:
        await self.show.set_queue(items)

    async def save_clip(self, info: Dict[str, Any], order: int) -> Optional[str]:
        from ..database import AsyncSessionLocal
        from ..repositories.edit_transaction import task_edit_transaction
        from ..services.task_service import TaskService

        async with AsyncSessionLocal() as db:
            service = TaskService(db)
            async with task_edit_transaction(db, self.task_id, processing=True):
                clips = await service.clip_repo.get_clips_by_task(db, self.task_id)
                # After the clips already there, whatever their order became.
                next_order = max([int(c.get("clip_order") or 0) for c in clips] + [0]) + 1
                clip_id = await service.clip_repo.create_clip(
                    db,
                    task_id=self.task_id,
                    filename=info["filename"],
                    file_path=info["path"],
                    start_time=info["start_time"],
                    end_time=info["end_time"],
                    duration=info["duration"],
                    text=info.get("text", ""),
                    relevance_score=info.get("relevance_score", 0.0),
                    reasoning=info.get("reasoning", ""),
                    clip_order=next_order,
                    virality_score=info.get("virality_score", 0),
                    hook_score=info.get("hook_score", 0),
                    engagement_score=info.get("engagement_score", 0),
                    value_score=info.get("value_score", 0),
                    shareability_score=info.get("shareability_score", 0),
                    hook_type=info.get("hook_type"),
                    hook_title=info.get("hook_title"),
                )
                await service.task_repo.update_task_clips(
                    db, self.task_id, [*(str(c["id"]) for c in clips), clip_id]
                )
            record = await service.clip_repo.get_clip_by_id(db, clip_id)
        if record:
            await self.tracker.clip_ready(next_order - 1, 0, record)
            await self.show.clip(stage="pronto", video_url=record.get("video_url"), filename=record.get("filename"))
        return clip_id

    async def progress(self, message: str) -> bool:
        from ..database import AsyncSessionLocal
        from ..repositories.task_repository import TaskRepository

        async with AsyncSessionLocal() as db:
            changed = await TaskRepository.update_task_status(
                db, self.task_id, "processing", progress=50,
                progress_message=message, expected_statuses=["processing"],
            )
        if changed is False:
            return False
        await self.tracker.update(50, message, "processing")
        return True

    async def control(self) -> Optional[str]:
        if await self.redis.get(f"task_cancel:{self.task_id}"):
            return "cancel"
        stop = await self.redis.get(f"live_stop:{self.task_id}")
        if stop:
            return "stop_now" if stop in (b"now", "now") else "stop"
        return None


async def watch_live(
    ctx: Dict[str, Any],
    task_id: str,
    url: str,
    user_id: str,
    options: Dict[str, Any],
    processing_mode: str = "fast",
    title: str = "Live",
) -> Dict[str, Any]:
    """Record one live stream and clip its moments until it ends or is stopped."""
    from ..database import AsyncSessionLocal
    from ..live.session import LiveOptions, LiveSession
    from ..repositories.task_repository import TaskRepository
    from ..runtime_settings import load_runtime_settings_cache
    from ..workers.progress import ProgressTracker

    set_trace_id(f"live-{task_id}")
    tracker = ProgressTracker(ctx["redis"], task_id)
    async with AsyncSessionLocal() as db:
        await load_runtime_settings_cache(db)
        task = await TaskRepository.get_task_by_id(db, task_id)
        if not task or task.get("status") not in {"queued", "processing"}:
            logger.info("Live %s is no longer active; nothing to watch", task_id)
            return {"status": "skipped"}
        await TaskRepository.update_task_status(
            db, task_id, "processing", progress=5, progress_message="Conectando na live...",
            expected_statuses=["queued", "processing"],
        )

    known = set(LiveOptions.__dataclass_fields__)
    live_options = LiveOptions(**{k: v for k, v in (options or {}).items() if k in known})
    hooks = ProductionLiveHooks(ctx, task_id, url, live_options, processing_mode)
    try:
        result = await LiveSession(task_id, live_options, hooks, title=title).run()
    except Exception as exc:
        job_try = int(ctx.get("job_try", 1))
        logger.error("Live %s crashed (try %d): %s", task_id, job_try, exc, exc_info=True)
        if job_try < LIVE_MAX_TRIES:
            # The session resumes from its saved state and reconnects.
            raise Retry(defer=10)
        result = {"status": "error", "clips": 0}

    clips, minutes = result.get("clips", 0), round(result.get("recorded_seconds", 0) / 60)
    if result["status"] == "cancelled":
        await hooks.show.finish()
        return result
    if result["status"] in {"not_live", "error"} and not clips:
        message = (
            "Não consegui assistir a live. Confira se ela está no ar e tente de novo."
            if result["status"] == "not_live"
            else "A gravação da live falhou. Os cortes prontos continuam aqui."
        )
        status, progress = "error", 0
    else:
        status, progress = "completed", 100
        message = (
            f"Live encerrada: {clips} {'corte' if clips == 1 else 'cortes'} de {minutes} min gravados."
            if clips
            else f"Live encerrada ({minutes} min). Nenhum momento chegou à nota mínima para virar corte."
        )
        if result.get("limit_reached"):
            message += " A gravação parou no limite de duração do seu plano."
    async with AsyncSessionLocal() as db:
        await TaskRepository.update_task_status(
            db, task_id, status, progress=progress, progress_message=message,
            expected_statuses=["queued", "processing"],
        )
    await tracker.update(progress, message, status)
    await hooks.show.finish()
    await ctx["redis"].delete(f"live_stop:{task_id}")
    return result


async def startup(ctx: Dict[str, Any]) -> None:
    """Room for every live's transcriptions, render and recording at once.

    The default thread pool is sized from the CPU count; on a small VPS the
    long transcriptions and renders filled it and the loop that reads "Parar"
    waited its turn.
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=32))


class LiveWorkerSettings:
    """arq settings for the live worker (its own queue and container)."""

    from arq.connections import RedisSettings

    on_startup = startup

    config = Config()
    functions = [func(watch_live, max_tries=LIVE_MAX_TRIES)]
    queue_name = LIVE_QUEUE_NAME
    health_check_interval = 30
    redis_settings = RedisSettings(
        host=config.redis_host, port=config.redis_port, password=config.redis_password, database=0
    )
    max_tries = LIVE_MAX_TRIES
    # Longer than the longest plan limit; the session stops itself before this.
    job_timeout = int(env_or_default("LIVE_JOB_TIMEOUT_SECONDS", str(13 * 3600)))
    max_jobs = config.live_max_concurrent
