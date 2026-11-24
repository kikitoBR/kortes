"""One render job per clip, on a queue of its own.

The analysis job (``TaskService.process_task``) hands the moments it chose to
this queue instead of rendering them itself. Each clip is an arq job on
``RENDER_QUEUE_NAME``, served by render workers that take one clip at a time,
so a clip gets the whole machine instead of sharing it with other tasks.

Fairness: a task keeps at most one clip waiting in the queue. The job for a
clip queues the task's next clip as soon as it starts, so the tasks of
different users take turns clip by clip, and an idle worker (another machine)
still picks up the same task's next clip at once.

A worker that goes away loses nothing: arq runs a job cancelled by a shutdown
again, and a crashed worker's job once its in-progress mark expires (the
render job timeout). A clip saved twice by such a rerun is dropped by the
per-clip claim.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..repositories.edit_transaction import TaskCancelled
from ..utils.async_helpers import run_in_thread
from ..workers.job_queue import DuplicateJobError, JobQueue
from .clip_source import ClipSource

logger = logging.getLogger(__name__)

RENDER_QUEUE_NAME = "supoclip_render"
RENDER_JOB_NAME = "render_clip"
PLAN_TTL_SECONDS = 3 * 24 * 3600
RENDER_PROGRESS_START = 70
RENDER_PROGRESS_SPAN = 25


def plan_key(task_id: str) -> str:
    return f"render_plan:{task_id}"


def done_key(task_id: str, run: str) -> str:
    return f"render_done:{task_id}:{run}"


def failed_key(task_id: str, run: str) -> str:
    return f"render_failed:{task_id}:{run}"


def claim_key(task_id: str, run: str, index: int) -> str:
    return f"render_claim:{task_id}:{run}:{index}"


def final_key(task_id: str, run: str) -> str:
    return f"render_final:{task_id}:{run}"


def render_job_id(task_id: str, run: str, index: int) -> str:
    return f"render:{task_id}:{run}:{index}"


def next_index(plan: Dict[str, Any], index: int) -> Optional[int]:
    """The task's clip that follows ``index`` in render order, if any."""
    todo: List[int] = plan["todo"]
    later = [i for i in todo if i > index]
    return later[0] if later else None


def render_progress(finished: int, todo: int) -> int:
    return RENDER_PROGRESS_START + int(RENDER_PROGRESS_SPAN * finished / max(todo, 1))


async def save_plan(redis, plan: Dict[str, Any]) -> None:
    await redis.set(plan_key(plan["task_id"]), json.dumps(plan, default=str), ex=PLAN_TTL_SECONDS)


async def load_plan(redis, task_id: str) -> Optional[Dict[str, Any]]:
    raw = await redis.get(plan_key(task_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


async def enqueue_clip(task_id: str, run: str, index: int) -> None:
    """Queue one clip; a job already queued (or finished) for it is kept."""
    try:
        await JobQueue.enqueue_job(
            RENDER_JOB_NAME,
            task_id,
            run,
            index,
            _queue_name=RENDER_QUEUE_NAME,
            _job_id=render_job_id(task_id, run, index),
        )
    except DuplicateJobError:
        logger.debug("Clip %d of task %s is already queued", index + 1, task_id)


class QueuedClipRenderMixin:
    """TaskService side of the render queue (needs its repos and helpers)."""

    async def _queue_clip_renders(
        self,
        *,
        task_id: str,
        url: str,
        source_type: str,
        video_path: Path,
        sections: bool,
        voice_energy: Optional[List[float]],
        segments: List[Dict[str, Any]],
        reused: Dict[int, str],
        settings: Dict[str, Any],
        stage_timings: Dict[str, float],
        show: Optional[Any],
    ) -> Dict[str, Any]:
        """Hand the chosen moments to the render queue; returns the plan."""
        todo = [index for index in range(len(segments)) if index not in reused]
        plan = {
            "run": uuid.uuid4().hex[:12],
            "task_id": task_id,
            "url": url,
            "source_type": source_type,
            "video_path": str(video_path),
            "sections": sections,
            "voice_energy": voice_energy,
            "segments": segments,
            "reused": {str(index): clip_id for index, clip_id in reused.items()},
            "todo": todo,
            "settings": settings,
            "stage_timings": stage_timings,
            "queued_at": time.time(),
        }
        pool = await JobQueue.get_pool()
        await save_plan(pool, plan)
        if show is not None:
            await show.set_queue([
                {
                    "n": index + 1,
                    "start": segment.get("start_time"),
                    "end": segment.get("end_time"),
                    "title": segment.get("hook_title"),
                    "status": "pronto" if index in reused else "na fila",
                }
                for index, segment in enumerate(segments)
            ])
        await enqueue_clip(task_id, plan["run"], todo[0])
        logger.info(
            "Task %s: %d clip(s) handed to the render queue (run %s)",
            task_id, len(todo), plan["run"],
        )
        return plan

    async def render_queued_clip(
        self,
        task_id: str,
        run: str,
        index: int,
        *,
        redis,
        progress,
        show: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Render, save and announce one clip of a task's render plan."""
        plan = await load_plan(redis, task_id)
        if not plan or plan.get("run") != run:
            # A newer run ("Retomar") or a finished task: this job is stale.
            return {"task_id": task_id, "index": index, "skipped": "stale"}

        task = await self.task_repo.get_task_by_id(self.db, task_id)
        if (
            not task
            or task.get("status") != "processing"
            or await redis.get(f"task_cancel:{task_id}")
        ):
            await self._close_queued_task(task_id, plan, redis=redis, show=show)
            return {"task_id": task_id, "index": index, "skipped": "not processing"}

        # The next clip waits in the queue behind other tasks' clips.
        following = next_index(plan, index)
        if following is not None:
            await enqueue_clip(task_id, run, following)

        if await redis.sismember(done_key(task_id, run), index):
            # A rerun of a job that already finished its clip.
            await self._maybe_finish_queued_task(task_id, plan, redis=redis, progress=progress, show=show)
            return {"task_id": task_id, "index": index, "skipped": "done"}

        segments = plan["segments"]
        total = len(segments)
        settings = plan["settings"]
        segment = segments[index]
        video_path = Path(plan["video_path"])
        clips_output_dir = Path(self.config.temp_dir) / "clips"
        clips_output_dir.mkdir(parents=True, exist_ok=True)
        finished = await redis.scard(done_key(task_id, run))
        failed = await redis.scard(failed_key(task_id, run))
        percent = render_progress(finished, len(plan["todo"]))

        async def update_progress(message: str) -> None:
            changed = await self.task_repo.update_task_status(
                self.db, task_id, "processing", progress=percent,
                progress_message=message, expected_statuses=["processing"],
            )
            if changed is False:
                raise TaskCancelled()
            await progress.update(percent, message, "processing")

        async def show_status(status: str) -> None:
            if show is not None:
                queue = show.state.get("queue") or []
                if index < len(queue):
                    queue[index]["status"] = status
                    await show.set_queue(queue)

        clip_path: Optional[Path] = None
        try:
            if show is not None:
                await show_status("montando")
                await show.start_clip(index, total, segment, settings["output_format"])
            review_note = None
            if self.config.clip_review_enabled:
                await update_progress(f"Revisando o clipe {index + 1} de {total}...")
                if show is not None:
                    await show.clip(stage="revisao")
                segment, review_note = await self._review_segment(
                    video_path,
                    segment,
                    index,
                    hook_intro=settings.get("hook_intro"),
                    voice_energy=plan.get("voice_energy"),
                    show=show,
                )
            message = f"Criando o clipe {index + 1} de {total}..."
            if failed:
                message += f" {failed} falhou e foi pulado." if failed == 1 else f" {failed} falharam e foram pulados."
            await update_progress(message)

            clip_info = await self.video_service.create_single_clip(
                video_path,
                segment,
                index,
                clips_output_dir,
                settings.get("font_family"),
                settings.get("font_size"),
                settings.get("font_color"),
                settings.get("caption_template") or "default",
                settings.get("output_format") or "vertical",
                settings.get("add_subtitles", True),
                settings.get("cleanup_settings"),
                webcam_region=settings.get("webcam_region"),
                hook_intro=settings.get("hook_intro"),
                title_overlay=settings.get("title_overlay") is not False,
                clip_source=(
                    ClipSource(video_path, plan["url"], sections=True)
                    if plan.get("sections")
                    else None
                ),
                show=show,
            )
            if clip_info is None:
                logger.warning("Task %s: clip %d of %d failed and was skipped", task_id, index + 1, total)
                await redis.sadd(failed_key(task_id, run), index)
                await show_status("falhou")
            else:
                clip_path = Path(clip_info["path"])
                self._add_review_note(clip_info, review_note)
                await self._save_queued_clip(task_id, run, index, total, clip_info, redis=redis, progress=progress, show=show)
                clip_path = None
                await show_status("pronto")
        except TaskCancelled:
            self._discard_clip_file(clip_path)
            await self._close_queued_task(task_id, plan, redis=redis, show=show)
            return {"task_id": task_id, "index": index, "skipped": "cancelled"}
        except BaseException:
            self._discard_clip_file(clip_path)
            raise

        await redis.sadd(done_key(task_id, run), index)
        await redis.expire(done_key(task_id, run), PLAN_TTL_SECONDS)
        await redis.expire(failed_key(task_id, run), PLAN_TTL_SECONDS)
        await self._maybe_finish_queued_task(task_id, plan, redis=redis, progress=progress, show=show)
        return {"task_id": task_id, "index": index, "rendered": clip_info is not None}

    async def give_up_queued_clip(self, task_id: str, run: str, index: int, *, redis, progress, show=None) -> None:
        """A clip whose job failed on every try counts as skipped."""
        plan = await load_plan(redis, task_id)
        if not plan or plan.get("run") != run:
            return
        await redis.sadd(failed_key(task_id, run), index)
        await redis.sadd(done_key(task_id, run), index)
        following = next_index(plan, index)
        if following is not None:
            await enqueue_clip(task_id, run, following)
        await self._maybe_finish_queued_task(task_id, plan, redis=redis, progress=progress, show=show)

    async def _save_queued_clip(
        self, task_id: str, run: str, index: int, total: int, clip_info: Dict[str, Any], *, redis, progress, show
    ) -> None:
        if not await redis.set(claim_key(task_id, run, index), "1", nx=True, ex=PLAN_TTL_SECONDS):
            # Another run of this job (a worker that came back) saved it first.
            self._discard_clip_file(Path(clip_info["path"]))
            return
        try:
            async with self._processing_transaction(task_id):
                clip_id = await self._create_clip_row(task_id, clip_info, index)
                clips = await self.clip_repo.get_clips_by_task(self.db, task_id)
                await self.task_repo.update_task_clips(self.db, task_id, [str(c["id"]) for c in clips])
        except BaseException:
            await redis.delete(claim_key(task_id, run, index))
            raise
        clip_record = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if clip_record:
            await progress.clip_ready(index, total, clip_record)
        if show is not None:
            await show.clip(
                stage="pronto",
                video_url=(clip_record or {}).get("video_url"),
                filename=(clip_record or {}).get("filename"),
            )

    async def _maybe_finish_queued_task(self, task_id: str, plan: Dict[str, Any], *, redis, progress, show) -> None:
        run = plan["run"]
        if await redis.scard(done_key(task_id, run)) < len(plan["todo"]):
            return
        if not await redis.set(final_key(task_id, run), "1", nx=True, ex=PLAN_TTL_SECONDS):
            return
        try:
            clips = await self.clip_repo.get_clips_by_task(self.db, task_id)
            stage_timings = dict(plan.get("stage_timings") or {})
            stage_timings["render_seconds"] = round(time.time() - float(plan.get("queued_at") or time.time()), 3)
            if not clips:
                message = "Nenhum clipe pôde ser renderizado. Tente novamente."
                failed = await self.task_repo.update_task_status(
                    self.db, task_id, "error", progress=0, progress_message=message,
                    expected_statuses=["processing"],
                )
                if failed is not False:
                    await self.task_repo.update_task_runtime_metadata(
                        self.db, task_id, completed_at=datetime.utcnow(), error_code="task_error",
                        stage_timings_json=json.dumps(stage_timings),
                    )
                    await progress.update(0, message, "error")
                return
            completed = await self.task_repo.update_task_status(
                self.db, task_id, "completed", progress=100, progress_message="Concluído!",
                expected_statuses=["processing"],
            )
            if completed is False:
                return
            await progress.update(100, "Concluído!", "completed")
            await self.task_repo.update_task_runtime_metadata(
                self.db, task_id, completed_at=datetime.utcnow(),
                stage_timings_json=json.dumps(stage_timings), error_code="",
            )
            await self._send_completion_notification_if_needed(task_id=task_id, clips_count=len(clips))
            logger.info("Task %s completed successfully with %d clips", task_id, len(clips))
        finally:
            await self._release_queued_task(task_id, plan, redis=redis, show=show)

    async def _close_queued_task(self, task_id: str, plan: Dict[str, Any], *, redis, show) -> None:
        """Cancelled or gone: free the source once, whichever job sees it first."""
        if await redis.set(final_key(task_id, plan["run"]), "1", nx=True, ex=PLAN_TTL_SECONDS):
            await self._release_queued_task(task_id, plan, redis=redis, show=show)

    async def _release_queued_task(self, task_id: str, plan: Dict[str, Any], *, redis, show) -> None:
        current = await load_plan(redis, task_id)
        if current and current.get("run") == plan["run"]:
            await redis.delete(plan_key(task_id))
        if show is not None:
            await show.finish()
        await run_in_thread(
            self._cleanup_source_video, Path(plan["video_path"]), plan["source_type"], plan["url"]
        )

    @staticmethod
    def _discard_clip_file(path: Optional[Path]) -> None:
        if not path:
            return
        try:
            path.unlink(missing_ok=True)
            path.with_suffix(".source_map.json").unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove unfinished clip %s", path)
