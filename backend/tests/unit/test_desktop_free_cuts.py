"""Kortes Desktop free plan: a free video tells the site how many cuts it really made."""

from contextlib import asynccontextmanager

import pytest

from src import desktop
from src.config import Config, set_config_override
from src.runtime_settings import _settings_cache


@pytest.fixture
def desktop_config(monkeypatch):
    cfg = Config()
    cfg.desktop = True
    cfg.kortes_site_url = "https://site.test"
    set_config_override(cfg)
    _settings_cache["KORTES_ACCOUNT_TOKEN"] = "ks_test"
    yield cfg
    _settings_cache.pop("KORTES_ACCOUNT_TOKEN", None)
    set_config_override(None)


def _fake_task(monkeypatch, metadata, clip_ids):
    from src.repositories import task_repository

    @asynccontextmanager
    async def session():
        yield object()

    async def load_source_metadata(db, task_id):
        return metadata

    async def get_task_by_id(db, task_id):
        return {"generated_clips_ids": clip_ids}

    monkeypatch.setattr("src.database.AsyncSessionLocal", session)
    monkeypatch.setattr(task_repository.TaskRepository, "load_source_metadata", staticmethod(load_source_metadata))
    monkeypatch.setattr(task_repository.TaskRepository, "get_task_by_id", staticmethod(get_task_by_id))
    calls = []

    async def site_request(method, path, **kwargs):
        calls.append((path, kwargs.get("payload"), kwargs.get("license_key")))
        return 200, {"ok": True}

    monkeypatch.setattr(desktop, "site_request", site_request)
    return calls


@pytest.mark.asyncio
async def test_a_short_video_gives_its_unused_free_cuts_back(desktop_config, monkeypatch):
    calls = _fake_task(monkeypatch, {"free_source": "yt:abc", "free_clips": 5}, ["c1", "c2", "c3"])
    await desktop.settle_task_free_cuts("task-1")
    assert calls == [("/clips/settle", {"source": "yt:abc", "clips": 3}, "ks_test")]


@pytest.mark.asyncio
async def test_every_free_video_reports_its_real_count_and_paid_ones_nothing(desktop_config, monkeypatch):
    # A resumed video can make more than its first run kept: the site gets the real count.
    calls = _fake_task(monkeypatch, {"free_source": "yt:abc", "free_clips": 5}, ["c"] * 5)
    await desktop.settle_task_free_cuts("task-1")
    calls_paid = _fake_task(monkeypatch, {}, [])
    await desktop.settle_task_free_cuts("task-2")
    assert calls == [("/clips/settle", {"source": "yt:abc", "clips": 5}, "ks_test")] and calls_paid == []


@pytest.mark.asyncio
async def test_a_failed_video_gives_everything_back(desktop_config, monkeypatch):
    calls = _fake_task(monkeypatch, {"free_source": "live:x:2026-11-24", "free_clips": 2}, [])
    await desktop.settle_task_free_cuts("task-3")
    assert calls == [("/clips/settle", {"source": "live:x:2026-11-24", "clips": 0}, "ks_test")]


@pytest.mark.asyncio
async def test_every_plan_reports_its_cuts_to_the_job_log(desktop_config, monkeypatch):
    # Paid: only the log (nothing to give back). Free live stopped after 1 of 5: both.
    calls = _fake_task(monkeypatch, {"cut_job": "job-paid"}, ["c1", "c2"])
    await desktop.settle_task_free_cuts("task-4")
    assert calls == [("/clips/settle", {"source": "", "clips": 2, "job": "job-paid"}, "ks_test")]
    calls = _fake_task(monkeypatch, {"free_source": "live:x:2026-11-26", "free_clips": 5, "cut_job": "job-1"}, ["c1"])
    await desktop.settle_task_free_cuts("task-5")
    assert calls == [("/clips/settle", {"source": "live:x:2026-11-26", "clips": 1, "job": "job-1"}, "ks_test")]


@pytest.mark.asyncio
async def test_a_refused_settle_is_logged(desktop_config, monkeypatch, caplog):
    _fake_task(monkeypatch, {"free_source": "yt:abc"}, ["c1"])

    async def refused(method, path, **kwargs):
        return 403, {"detail": "Esta conta está ativa em outro computador."}

    monkeypatch.setattr(desktop, "site_request", refused)
    with caplog.at_level("WARNING"):
        await desktop.settle_task_free_cuts("task-6")
    assert "refused to settle task task-6 (403)" in caplog.text
