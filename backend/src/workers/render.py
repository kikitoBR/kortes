"""Render worker: one clip at a time from the render queue.

Runs as the ``render-worker`` service next to the main worker, and on any
helper machine that reaches the same Redis, PostgreSQL and media storage.
It only renders clips (no crons, no analysis), so a helper can join and leave
at any time: see ``services/clip_render_queue.py``.

    arq src.workers.render.RenderWorkerSettings
"""

import logging
from typing import Any, Dict

from arq import Retry

from ..config import Config, env_or_default
from ..observability import configure_logging, set_trace_id
from ..services.clip_render_queue import RENDER_QUEUE_NAME

configure_logging()

logger = logging.getLogger(__name__)

RENDER_MAX_TRIES = 3


async def render_clip(ctx: Dict[str, Any], task_id: str, run: str, index: int) -> Dict[str, Any]:
    from ..database import AsyncSessionLocal
    from ..media_storage import media_work
    from ..runtime_settings import load_runtime_settings_cache
    from ..services.task_service import TaskService
    from ..show import ShowReporter
    from .progress import ProgressTracker

    set_trace_id(f"task-{task_id}")
    redis = ctx["redis"]
    progress = ProgressTracker(redis, task_id)

    async with AsyncSessionLocal() as db:
        await load_runtime_settings_cache(db)
        service = TaskService(db)
        show = await ShowReporter(redis, task_id).load()

        @media_work
        async def run_clip() -> Dict[str, Any]:
            return await service.render_queued_clip(
                task_id, run, index, redis=redis, progress=progress, show=show
            )

        try:
            return await run_clip()
        except Exception as exc:
            await db.rollback()
            job_try = int(ctx.get("job_try", 1))
            if job_try < RENDER_MAX_TRIES:
                logger.warning(
                    "Clip %d of task %s failed (try %d): %s", index + 1, task_id, job_try, exc,
                    exc_info=True,
                )
                raise Retry(defer=10 * job_try)
            logger.error("Clip %d of task %s failed for good: %s", index + 1, task_id, exc, exc_info=True)
            await service.give_up_queued_clip(task_id, run, index, redis=redis, progress=progress, show=show)
            return {"task_id": task_id, "index": index, "rendered": False}


class RenderWorkerSettings:
    """arq settings for render workers (the main machine and helpers)."""

    from arq.connections import RedisSettings

    config = Config()

    functions = [render_clip]
    queue_name = RENDER_QUEUE_NAME
    health_check_interval = 30
    redis_settings = RedisSettings(
        host=config.redis_host, port=config.redis_port, password=config.redis_password, database=0
    )
    # render_clip gives up on a clip after RENDER_MAX_TRIES errors; the extra
    # tries are for reruns after a helper shut down mid-clip, which arq also
    # counts (a job past max_tries would never be marked done).
    max_tries = 12
    # Also how long a vanished worker's clip waits before another worker
    # takes it (arq's in-progress mark lasts the job timeout).
    job_timeout = int(env_or_default("RENDER_JOB_TIMEOUT_SECONDS", "1800"))
    # One clip at a time: each clip gets the whole machine.
    max_jobs = int(env_or_default("RENDER_MAX_JOBS", "1"))
