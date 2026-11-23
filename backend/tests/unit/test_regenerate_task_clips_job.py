from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.workers import tasks


def _ctx():
    redis = SimpleNamespace(setex=AsyncMock(), publish=AsyncMock())
    return {"redis": redis}


def _patch(monkeypatch, regenerate):
    statuses = []

    async def update_task_status(_db, _task_id, status, progress=None, progress_message=None, expected_statuses=None):
        statuses.append((status, progress, progress_message))
        return True

    service = SimpleNamespace(
        task_repo=SimpleNamespace(update_task_status=update_task_status),
        regenerate_all_clips_for_task=regenerate,
    )

    @asynccontextmanager
    async def sessions():
        yield SimpleNamespace(rollback=AsyncMock())

    monkeypatch.setattr("src.database.AsyncSessionLocal", sessions)
    monkeypatch.setattr("src.runtime_settings.load_runtime_settings_cache", AsyncMock())
    monkeypatch.setattr("src.services.task_service.TaskService", lambda _db: service)
    return statuses


@pytest.mark.asyncio
async def test_the_job_reports_each_clip_and_puts_the_status_back(monkeypatch):
    async def regenerate(task_id, *_args, progress_callback=None, **_kwargs):
        await progress_callback(0, 2)
        await progress_callback(1, 2)
        return {"done": 2, "failed": 0}

    statuses = _patch(monkeypatch, regenerate)
    result = await tasks.regenerate_task_clips(_ctx(), "task", "completed", {"caption_template": "default"})

    assert result["done"] == 2
    assert statuses[0] == ("processing", 0, "Refazendo o clipe 1 de 2…")
    assert statuses[1] == ("processing", 50, "Refazendo o clipe 2 de 2…")
    assert statuses[-1][0] == "completed" and statuses[-1][1] == 100


@pytest.mark.asyncio
async def test_a_failed_job_keeps_the_clips_and_the_previous_status(monkeypatch):
    regenerate = AsyncMock(side_effect=RuntimeError("download failed"))
    statuses = _patch(monkeypatch, regenerate)

    result = await tasks.regenerate_task_clips(_ctx(), "task", "completed", {})

    assert result["error"] == "download failed"
    assert statuses[-1][0] == "completed"
    assert "continuam como estavam" in statuses[-1][2]
