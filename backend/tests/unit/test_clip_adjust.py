import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from src.ai import ClipAdjustment
from src.config import Config
from src.services.clip_source import ClipSource
from src.services.task_service import TaskService


@pytest.fixture
def service(tmp_path, monkeypatch):
    @asynccontextmanager
    async def transaction(_db, _task_id):
        yield

    monkeypatch.setattr("src.repositories.edit_transaction.task_edit_transaction", transaction)
    config = Config()
    config.temp_dir = str(tmp_path)
    timing = tmp_path / "abc123DEF45.mp4"
    words = [{"text": w, "start": s * 1000, "end": s * 1000 + 500} for s, w in [(595, "antes"), (600, "começo"), (640, "fim.")]]
    timing.with_suffix(".transcript_cache.json").write_text(json.dumps({"words": words}))
    clip = {
        "id": "clip-1", "task_id": "task-1", "clip_order": 2, "file_path": str(tmp_path / "clip.mp4"),
        "start_time": "10:00", "end_time": "10:40", "text": "começo fim.", "hook_title": "Antigo",
    }
    svc = TaskService(db=None, config=config)
    svc.clip_repo.get_clip_by_id = AsyncMock(return_value=clip)
    svc.clip_repo.update_clip = AsyncMock()
    svc.clip_repo.update_clip_hook_title = AsyncMock()
    svc.task_repo.get_task_by_id = AsyncMock(return_value={"source_url": "https://youtu.be/abc123DEF45", "source_type": "youtube"})
    svc._load_task_source_settings = AsyncMock(return_value={"output_format": "vertical", "add_subtitles": True, "hook_intro": True})
    svc._get_clip_source_ranges = lambda _clip: [(600.0, 640.0)]
    svc._clip_source_for_task = AsyncMock(return_value=ClipSource(timing))
    svc.video_service.create_single_clip = AsyncMock(return_value={
        "filename": "new.mp4", "path": str(tmp_path / "new.mp4"), "start_time": "09:57",
        "end_time": "10:40", "duration": 43.0, "text": "antes começo fim.",
    })
    return svc


@pytest.mark.asyncio
async def test_a_request_renders_the_clip_again_and_saves_it(service, monkeypatch):
    asked = AsyncMock(return_value=ClipAdjustment(
        start_time="09:57", end_time="10:40", hook_title="Título novo", reply="Comecei 3 s antes."
    ))
    monkeypatch.setattr("src.ai.adjust_clip", asked)

    result = await service.adjust_clip_with_text("task-1", "clip-1", "começa 3 s antes e troca o título")

    assert "começa 3 s antes" in asked.await_args.args[0]
    segment = service.video_service.create_single_clip.await_args.args[1]
    assert (segment["start_time"], segment["end_time"], segment["hook_title"]) == ("09:57", "10:40", "Título novo")
    assert service.video_service.create_single_clip.await_args.args[2] == 1  # clip_order 2
    assert service.video_service.create_single_clip.await_args.kwargs["hook_intro"] is True
    service.clip_repo.update_clip.assert_awaited_once()
    service.clip_repo.update_clip_hook_title.assert_awaited_once_with(None, "clip-1", "Título novo")
    assert result["reply"] == "Comecei 3 s antes."


@pytest.mark.asyncio
async def test_an_impossible_request_changes_nothing(service, monkeypatch):
    monkeypatch.setattr("src.ai.adjust_clip", AsyncMock(return_value=ClipAdjustment(
        start_time="10:00", end_time="10:04", reply="."
    )))
    with pytest.raises(ValueError, match="menos de 15"):
        await service.adjust_clip_with_text("task-1", "clip-1", "deixa com 4 segundos")
    service.video_service.create_single_clip.assert_not_awaited()
    service.clip_repo.update_clip.assert_not_awaited()
