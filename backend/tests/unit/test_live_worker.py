from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from arq import Retry

from src.workers import live as live_worker


@pytest.fixture
def job(monkeypatch):
    @asynccontextmanager
    async def sessions():
        yield SimpleNamespace()

    monkeypatch.setattr("src.database.AsyncSessionLocal", sessions)
    monkeypatch.setattr("src.runtime_settings.load_runtime_settings_cache", AsyncMock())
    repo = "src.repositories.task_repository.TaskRepository"
    monkeypatch.setattr(f"{repo}.get_task_by_id", AsyncMock(return_value={"status": "queued"}))
    status = AsyncMock(return_value=True)
    monkeypatch.setattr(f"{repo}.update_task_status", status)
    redis = SimpleNamespace(
        delete=AsyncMock(), get=AsyncMock(return_value=None), setex=AsyncMock(), publish=AsyncMock()
    )
    return SimpleNamespace(ctx={"redis": redis, "job_try": 1}, status=status)


def session_returning(monkeypatch, outcome):
    class FakeSession:
        def __init__(self, *args, **kwargs):
            pass

        async def run(self):
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr("src.live.session.LiveSession", FakeSession)


async def run(job):
    return await live_worker.watch_live(job.ctx, "task-1", "https://twitch.tv/x", "user-1", {"output_format": "vertical"})


@pytest.mark.asyncio
async def test_a_finished_live_completes_with_a_summary(monkeypatch, job):
    session_returning(monkeypatch, {"status": "completed", "clips": 3, "recorded_seconds": 7260, "limit_reached": True})
    await run(job)
    final = job.status.await_args_list[-1]
    assert final.args[2] == "completed"
    assert "3 cortes de 121 min" in final.kwargs["progress_message"]
    assert "limite de duração do seu plano" in final.kwargs["progress_message"]


@pytest.mark.asyncio
async def test_a_live_that_never_opened_is_an_error(monkeypatch, job):
    session_returning(monkeypatch, {"status": "not_live", "clips": 0})
    await run(job)
    final = job.status.await_args_list[-1]
    assert final.args[2] == "error" and "está no ar" in final.kwargs["progress_message"]


@pytest.mark.asyncio
async def test_a_crash_resumes_the_live(monkeypatch, job):
    session_returning(monkeypatch, RuntimeError("ffmpeg died"))
    with pytest.raises(Retry):
        await run(job)
    job.ctx["job_try"] = live_worker.LIVE_MAX_TRIES
    await run(job)
    assert job.status.await_args_list[-1].args[2] == "error"
