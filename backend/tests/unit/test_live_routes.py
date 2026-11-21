from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from src.api.routes import tasks
from src.live.capture import LiveStream
from src.services.video_service import VideoService

ON_AIR = LiveStream("Gameplay ao vivo", True, [{"url": "https://cdn.example/live.m3u8"}])


@pytest.fixture
def creation(monkeypatch):
    billing = {"max_youtube_duration_seconds": 3 * 3600}
    monkeypatch.setattr(tasks.BillingService, "assert_can_create_task", AsyncMock(return_value=billing))
    monkeypatch.setattr(tasks, "_get_user_id_from_headers", AsyncMock(return_value="user-1"))
    saved = AsyncMock()
    monkeypatch.setattr(tasks, "_save_task_source_metadata", saved)
    monkeypatch.setattr(tasks.TaskRepository, "count_active_live_tasks", AsyncMock(return_value=0))
    service = SimpleNamespace(
        video_service=VideoService(),
        create_task_with_source=AsyncMock(return_value="task-1"),
    )
    monkeypatch.setattr(tasks, "TaskService", lambda _db: service)
    enqueue = AsyncMock(return_value="job-live")
    monkeypatch.setattr(tasks.JobQueue, "enqueue_job", enqueue)
    queue = SimpleNamespace(enqueue_processing_job=AsyncMock(return_value="job-1"))
    request = SimpleNamespace(
        json=AsyncMock(return_value={"source": {"url": "https://www.twitch.tv/streamer"}}),
        app=SimpleNamespace(state=SimpleNamespace(queue_adapter=queue)),
    )
    return SimpleNamespace(request=request, service=service, queue=queue, enqueue=enqueue, saved=saved)


def probe(monkeypatch, result):
    mock = (lambda _url: result) if not isinstance(result, Exception) else (lambda _url: (_ for _ in ()).throw(result))
    monkeypatch.setattr("src.live.capture.probe_live", mock)


@pytest.mark.asyncio
async def test_a_live_channel_becomes_a_live_task(monkeypatch, creation):
    probe(monkeypatch, ON_AIR)
    result = await tasks.create_task(creation.request, db=None)

    assert result["live"] is True and result["task_id"] == "task-1"
    kwargs = creation.service.create_task_with_source.await_args.kwargs
    assert kwargs["source_type"] == "live" and kwargs["title"] == "Gameplay ao vivo"
    creation.queue.enqueue_processing_job.assert_not_awaited()
    args, options = creation.enqueue.await_args.args, creation.enqueue.await_args.kwargs
    assert args[0] == "watch_live" and args[1] == "task-1"
    assert args[4]["max_seconds"] == 3 * 3600  # recording stops at the plan's limit
    assert options["_queue_name"] == "supoclip_live"
    metadata = creation.saved.await_args.args[1]
    assert metadata["live"] is True and metadata["processing_job_id"] == options["_job_id"]


@pytest.mark.asyncio
async def test_an_offline_channel_uses_no_generation(monkeypatch, creation):
    probe(monkeypatch, LiveStream("Canal", False, []))
    with pytest.raises(HTTPException) as error:
        await tasks.create_task(creation.request, db=None)
    assert error.value.status_code == 422 and error.value.detail["code"] == "LIVE_NOT_ON_AIR"
    creation.service.create_task_with_source.assert_not_awaited()
    creation.enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_youtube_live_without_duration_is_clipped_live(monkeypatch, creation):
    creation.request.json.return_value = {"source": {"url": "https://www.youtube.com/watch?v=abcdefghijk"}}
    monkeypatch.setattr(tasks, "async_get_youtube_video_info", AsyncMock(return_value={"duration": None}))
    probe(monkeypatch, ON_AIR)
    result = await tasks.create_task(creation.request, db=None)
    assert result["live"] is True
    assert creation.service.create_task_with_source.await_args.kwargs["source_type"] == "live"


@pytest.mark.asyncio
async def test_too_many_lives_at_once_are_refused(monkeypatch, creation):
    probe(monkeypatch, ON_AIR)
    monkeypatch.setattr(tasks.TaskRepository, "count_active_live_tasks", AsyncMock(return_value=99))
    with pytest.raises(HTTPException) as error:
        await tasks.create_task(creation.request, db=None)
    assert error.value.status_code == 429
    creation.service.create_task_with_source.assert_not_awaited()
