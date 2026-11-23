"""The render queue: one job per clip, tasks taking turns clip by clip."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.config import Config
from src.repositories.edit_transaction import TaskCancelled
from src.services import clip_render_queue as queue_module
from src.services.clip_render_queue import load_plan
from src.services.task_service import TaskService


class FakeRedis:
    """The few Redis calls the render queue makes, in memory."""

    def __init__(self):
        self.values = {}
        self.sets = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = value
        return True

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)
            self.sets.pop(key, None)

    async def sadd(self, key, *members):
        bucket = self.sets.setdefault(key, set())
        before = len(bucket)
        bucket.update(members)
        return len(bucket) - before

    async def scard(self, key):
        return len(self.sets.get(key, set()))

    async def sismember(self, key, member):
        return member in self.sets.get(key, set())

    async def expire(self, key, seconds):
        return True


def clip_result(index: int) -> dict:
    return {
        "filename": f"clip-{index}.mp4",
        "path": f"/tmp/clip-{index}.mp4",
        "start_time": "00:00",
        "end_time": "00:10",
        "duration": 10.0,
        "text": "Hook text",
    }


@pytest.fixture
def queue(monkeypatch):
    redis = FakeRedis()
    enqueued = []

    async def enqueue_clip(task_id, run, index):
        enqueued.append((task_id, index))

    monkeypatch.setattr(queue_module.JobQueue, "get_pool", AsyncMock(return_value=redis))
    monkeypatch.setattr(queue_module, "enqueue_clip", enqueue_clip)
    return SimpleNamespace(redis=redis, enqueued=enqueued)


def build_service(segments, status="processing") -> TaskService:
    config = Config()
    config.clip_review_enabled = False
    config.clip_render_queue = True
    service = TaskService(db=AsyncMock(), config=config)
    service._load_performance_context = AsyncMock(return_value=None)
    service._processing_transaction = lambda _task_id: nullcontext()
    service._task_run_guard = lambda _task_id: nullcontext()
    service._cleanup_source_video = lambda *args: None
    service._send_completion_notification_if_needed = AsyncMock()
    service.task_repo.get_task_by_id = AsyncMock(return_value={"status": status})
    service.task_repo.update_task_status = AsyncMock(return_value=True)
    service.task_repo.update_task_runtime_metadata = AsyncMock()
    service.task_repo.update_task_clips = AsyncMock()
    service.cache_repo.get_cache = AsyncMock(return_value=None)
    service.cache_repo.upsert_cache = AsyncMock()
    saved = []

    async def create_clip(_db, **row):
        saved.append(row)
        return f"clip-{row['clip_order']}"

    async def get_clips_by_task(_db, _task_id):
        return [{"id": f"clip-{row['clip_order']}", "clip_order": row["clip_order"]} for row in saved]

    service.saved = saved
    service.clip_repo.create_clip = create_clip
    service.clip_repo.get_clips_by_task = AsyncMock(side_effect=get_clips_by_task)
    service.clip_repo.delete_clip = AsyncMock()
    service.clip_repo.get_clip_by_id = AsyncMock(side_effect=lambda _db, clip_id: {"id": clip_id})
    service.video_service.create_single_clip = AsyncMock(
        side_effect=lambda _path, _segment, index, *args, **kwargs: clip_result(index)
    )
    service.video_service.process_video_complete = AsyncMock(
        return_value={
            "segments_to_render": segments,
            "video_path": "/tmp/source.mp4",
            "segments": [],
            "summary": None,
            "key_topics": [],
            "transcript": "Transcript",
            "analysis_json": "{}",
            "voice_energy": [0.0, 1.5],
        }
    )
    return service


SEGMENTS = [
    {"start_time": "00:10", "end_time": "00:40", "hook_title": "Um"},
    {"start_time": "01:10", "end_time": "01:40", "hook_title": "Dois"},
    {"start_time": "02:10", "end_time": "02:40", "hook_title": "Tres"},
]


def progress_tracker():
    return SimpleNamespace(update=AsyncMock(), clip_ready=AsyncMock())


async def hand_off(service, task_id="task-1"):
    return await service.process_task(
        task_id=task_id,
        url="https://www.youtube.com/watch?v=demo",
        source_type="youtube",
        output_format="vertical",
    )


async def test_the_task_job_hands_its_clips_to_the_render_queue(queue):
    service = build_service(SEGMENTS)
    cleanup = []
    service._cleanup_source_video = lambda *args: cleanup.append(args)

    result = await hand_off(service)

    assert result["queued_clips"] == 3
    service.video_service.create_single_clip.assert_not_awaited()
    plan = await load_plan(queue.redis, "task-1")
    assert plan["todo"] == [0, 1, 2]
    assert plan["voice_energy"] == [0.0, 1.5]
    assert plan["settings"]["output_format"] == "vertical"
    # Only the first clip waits in the queue; each clip queues the next.
    assert queue.enqueued == [("task-1", 0)]
    # The render jobs own the source video now.
    assert cleanup == []


async def test_each_clip_queues_the_next_and_the_last_completes_the_task(queue):
    service = build_service(SEGMENTS)
    cleanup = []
    service._cleanup_source_video = lambda *args: cleanup.append(args)
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    progress = progress_tracker()

    for index in range(3):
        await service.render_queued_clip("task-1", run, index, redis=queue.redis, progress=progress)

    assert queue.enqueued == [("task-1", 0), ("task-1", 1), ("task-1", 2)]
    assert [row["clip_order"] for row in service.saved] == [1, 2, 3]
    # The task's clip list follows clip order, whatever machine finished first.
    assert service.task_repo.update_task_clips.await_args.args[2] == ["clip-1", "clip-2", "clip-3"]
    assert progress.clip_ready.await_count == 3
    service.task_repo.update_task_status.assert_any_await(
        service.db, "task-1", "completed", progress=100, progress_message="Concluído!",
        expected_statuses=["processing"],
    )
    progress.update.assert_any_await(100, "Concluído!", "completed")
    assert len(cleanup) == 1
    assert await load_plan(queue.redis, "task-1") is None


async def test_two_tasks_take_turns_clip_by_clip(queue):
    """With one waiting job per task, the FIFO queue alternates between tasks."""
    first, second = build_service(SEGMENTS), build_service(SEGMENTS)
    await hand_off(first, "task-a")
    await hand_off(second, "task-b")
    services = {"task-a": first, "task-b": second}
    runs = {task: (await load_plan(queue.redis, task))["run"] for task in services}

    order = []
    while queue.enqueued:
        task_id, index = queue.enqueued.pop(0)
        order.append((task_id, index))
        await services[task_id].render_queued_clip(
            task_id, runs[task_id], index, redis=queue.redis, progress=progress_tracker()
        )

    assert order == [
        ("task-a", 0), ("task-b", 0), ("task-a", 1), ("task-b", 1), ("task-a", 2), ("task-b", 2),
    ]


async def test_a_rerun_after_a_vanished_worker_saves_the_clip_once(queue):
    service = build_service(SEGMENTS[:2])
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    progress = progress_tracker()

    await service.render_queued_clip("task-1", run, 0, redis=queue.redis, progress=progress)
    await service.render_queued_clip("task-1", run, 0, redis=queue.redis, progress=progress)

    assert [row["clip_order"] for row in service.saved] == [1]


async def test_a_clip_rendered_twice_at_once_keeps_one_copy(queue, tmp_path):
    service = build_service(SEGMENTS[:2])
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    # The other worker claimed the clip while this one was still rendering.
    await queue.redis.set(queue_module.claim_key("task-1", run, 0), "1")
    duplicate = tmp_path / "clip-0.mp4"
    duplicate.write_bytes(b"video")
    service.video_service.create_single_clip = AsyncMock(
        return_value={**clip_result(0), "path": str(duplicate)}
    )

    await service.render_queued_clip("task-1", run, 0, redis=queue.redis, progress=progress_tracker())

    assert service.saved == []
    assert not duplicate.exists()


async def test_a_job_from_an_older_run_does_nothing(queue):
    service = build_service(SEGMENTS)
    await hand_off(service)

    result = await service.render_queued_clip(
        "task-1", "old-run", 0, redis=queue.redis, progress=progress_tracker()
    )

    assert result["skipped"] == "stale"
    service.video_service.create_single_clip.assert_not_awaited()


async def test_a_cancelled_task_stops_its_clips_and_frees_the_source_once(queue):
    service = build_service(SEGMENTS)
    cleanup = []
    service._cleanup_source_video = lambda *args: cleanup.append(args)
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    service.task_repo.get_task_by_id = AsyncMock(return_value={"status": "cancelled"})

    skipped = [
        (await service.render_queued_clip(
            "task-1", run, index, redis=queue.redis, progress=progress_tracker()
        ))["skipped"]
        for index in (0, 1)
    ]

    # The first job frees the task; a later one finds no plan left.
    assert skipped == ["not processing", "stale"]

    service.video_service.create_single_clip.assert_not_awaited()
    assert queue.enqueued == [("task-1", 0)]
    assert len(cleanup) == 1


async def test_cancelling_during_a_render_drops_the_unsaved_clip(queue, tmp_path):
    service = build_service(SEGMENTS[:1])
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    rendered = tmp_path / "clip-0.mp4"
    rendered.write_bytes(b"video")
    service.video_service.create_single_clip = AsyncMock(
        return_value={**clip_result(0), "path": str(rendered)}
    )

    def cancelled_transaction(_task_id):
        raise TaskCancelled()

    service._processing_transaction = cancelled_transaction

    result = await service.render_queued_clip(
        "task-1", run, 0, redis=queue.redis, progress=progress_tracker()
    )

    assert result["skipped"] == "cancelled"
    assert not rendered.exists()


async def test_failed_clips_are_skipped_and_a_task_with_none_errors(queue):
    service = build_service(SEGMENTS[:2])
    await hand_off(service)
    run = (await load_plan(queue.redis, "task-1"))["run"]
    service.video_service.create_single_clip = AsyncMock(return_value=None)
    progress = progress_tracker()

    await service.render_queued_clip("task-1", run, 0, redis=queue.redis, progress=progress)
    await service.give_up_queued_clip("task-1", run, 1, redis=queue.redis, progress=progress)

    service.task_repo.update_task_status.assert_any_await(
        service.db, "task-1", "error", progress=0,
        progress_message="Nenhum clipe pôde ser renderizado. Tente novamente.",
        expected_statuses=["processing"],
    )


async def test_clips_kept_from_an_earlier_run_are_not_queued_again(queue):
    service = build_service(SEGMENTS)
    service.clip_repo.get_clips_by_task = AsyncMock(return_value=[
        {"id": "kept-1", "clip_order": 1, "start_time": "00:10", "end_time": "00:40"},
    ])

    await hand_off(service)

    plan = await load_plan(queue.redis, "task-1")
    assert plan["todo"] == [1, 2]
    assert plan["reused"] == {"0": "kept-1"}
    assert queue.enqueued == [("task-1", 1)]


async def test_without_the_render_queue_the_task_renders_its_own_clips(queue):
    service = build_service(SEGMENTS[:1])
    service.config.clip_render_queue = False

    await hand_off(service)

    service.video_service.create_single_clip.assert_awaited_once()
    assert queue.enqueued == []
