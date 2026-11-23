from unittest.mock import AsyncMock
from types import SimpleNamespace
from pathlib import Path

import pytest

from src.clip_source_map import (
    load_clip_source_ranges,
    save_clip_source_ranges,
    split_source_ranges,
    trim_source_ranges,
)
from src.services.task_service import TaskService


def test_trim_source_ranges_preserves_non_contiguous_mapping():
    trimmed = trim_source_ranges([(10.0, 11.0), (13.0, 15.0)], 1.0, 0.0)

    assert trimmed == [(13.0, 15.0)]


def test_split_source_ranges_preserves_non_contiguous_mapping():
    first, second = split_source_ranges([(10.0, 11.0), (13.0, 15.0)], 1.0)

    assert first == [(10.0, 11.0)]
    assert second == [(13.0, 15.0)]


def test_save_and_load_clip_source_ranges(tmp_path):
    clip_path = tmp_path / "clip.mp4"
    clip_path.write_bytes(b"")

    save_clip_source_ranges(clip_path, [(10.0, 11.0), (13.0, 15.0)])

    assert load_clip_source_ranges(clip_path) == [(10.0, 11.0), (13.0, 15.0)]


class _FakeClipRepo:
    def __init__(self, clip: dict):
        self.clip = dict(clip)

    async def get_clip_by_id(self, _db, _clip_id: str):
        return dict(self.clip)

    async def update_clip(
        self,
        _db,
        _clip_id: str,
        filename: str,
        file_path: str,
        start_time: str,
        end_time: str,
        duration: float,
        text: str,
    ):
        self.clip.update(
            {
                "filename": filename,
                "file_path": file_path,
                "start_time": start_time,
                "end_time": end_time,
                "duration": duration,
                "text": text,
            }
        )


@pytest.mark.asyncio
async def test_trim_clip_uses_persisted_source_ranges(isolated_clip_edits, monkeypatch, tmp_path):
    input_path = tmp_path / "clip.mp4"
    input_path.write_bytes(b"input")
    save_clip_source_ranges(input_path, [(10.0, 11.0), (13.0, 15.0)])

    output_path = tmp_path / "trimmed.mp4"
    output_path.write_bytes(b"output")

    import threading
    request_thread = threading.get_ident()
    render_threads = []

    def render_trim(*_args, **_kwargs):
        render_threads.append(threading.get_ident())
        return output_path

    monkeypatch.setattr("src.services.clip_service.trim_clip_file", render_trim)

    repo = _FakeClipRepo(
        {
            "id": "clip-1",
            "task_id": "task-1",
            "file_path": str(input_path),
            "filename": "clip.mp4",
            "start_time": "00:10",
            "end_time": "00:20",
            "duration": 3.0,
            "text": "hello",
        }
    )

    service = TaskService(db=None)
    service.clip_repo = repo

    clip = await service.trim_clip("task-1", "clip-1", 1.0, 0.0)

    assert render_threads and render_threads[0] != request_thread
    assert clip["start_time"] == "00:13"
    assert clip["end_time"] == "00:15"
    assert clip["duration"] == pytest.approx(2.0)
    assert load_clip_source_ranges(output_path) == [(13.0, 15.0)]


def _regeneration_service(tmp_path, monkeypatch, captured):
    """A TaskService whose clip renders are recorded instead of made."""
    clip_path = tmp_path / "clip.mp4"
    clip_path.write_bytes(b"clip")
    save_clip_source_ranges(clip_path, [(10.0, 11.0), (13.0, 15.0)])
    clip = {
        "id": "clip-1", "task_id": "task-1", "file_path": str(clip_path), "clip_order": 1,
        "start_time": "00:10", "end_time": "00:20", "duration": 3.0, "text": "hello",
        "hook_title": "Title",
    }

    class _Source:
        timing_path = tmp_path / "source.mp4"
        closed = False

        def close(self):
            _Source.closed = True

    async def render(_timing, segment, _index, output_dir, *_args, **_kwargs):
        captured.setdefault("segments", []).append(segment)
        if captured.get("fail"):
            return None
        return {"filename": "new.mp4", "path": str(output_dir / "new.mp4"), "start_time": "00:10",
                "end_time": "00:15", "duration": 3.0, "text": "hello"}

    service = TaskService(db=None)
    service.config.temp_dir = str(tmp_path)
    service.task_repo = SimpleNamespace(
        get_task_by_id=AsyncMock(return_value={"id": "task-1", "source_url": "upload://source.mp4", "source_type": "video_url"})
    )
    service.clip_repo = SimpleNamespace(
        get_clips_by_task=AsyncMock(return_value=[clip]), update_clip=AsyncMock()
    )
    service.video_service = SimpleNamespace(create_single_clip=render)
    service._clip_source_for_task = AsyncMock(return_value=_Source())

    async def settings(_task_id: str):
        return {"output_format": "vertical", "add_subtitles": True, "cut_long_pauses": False,
                "pause_threshold_ms": 900, "remove_filler_words": False, "filtered_words": []}

    monkeypatch.setattr(service, "_load_task_source_settings", settings)
    return service, _Source


@pytest.mark.asyncio
async def test_regenerate_all_clips_reuses_persisted_source_ranges(isolated_clip_edits, monkeypatch, tmp_path):
    captured: dict[str, object] = {}
    service, source = _regeneration_service(tmp_path, monkeypatch, captured)

    result = await service.regenerate_all_clips_for_task(
        "task-1", "TikTokSans-Regular", 24, "#FFFFFF", "default", cleanup_settings={}
    )

    segment = captured["segments"][0]
    assert segment["keep_ranges"] == [(10.0, 11.0), (13.0, 15.0)]
    assert segment["hook_title"] == "Title"
    # The clip keeps its row (id, moment, title): only its file changes.
    service.clip_repo.update_clip.assert_awaited_once()
    assert service.clip_repo.update_clip.await_args.args[1] == "clip-1"
    assert result == {"done": 1, "failed": 0}
    assert source.closed


@pytest.mark.asyncio
async def test_regenerate_all_clips_recomputes_cleanup_from_source_ranges(isolated_clip_edits,
    monkeypatch, tmp_path
):
    captured: dict[str, object] = {}
    service, _ = _regeneration_service(tmp_path, monkeypatch, captured)

    await service.regenerate_all_clips_for_task(
        "task-1", "TikTokSans-Regular", 24, "#FFFFFF", "default",
        cleanup_settings={"cut_long_pauses": True},
    )

    segment = captured["segments"][0]
    assert "keep_ranges" not in segment
    assert segment["source_ranges"] == [(10.0, 11.0), (13.0, 15.0)]


@pytest.mark.asyncio
async def test_regeneration_keeps_a_clip_that_fails_and_reports_progress(isolated_clip_edits, monkeypatch, tmp_path):
    captured: dict[str, object] = {"fail": True}
    service, source = _regeneration_service(tmp_path, monkeypatch, captured)
    steps = []

    async def progress(index, total):
        steps.append((index, total))

    result = await service.regenerate_all_clips_for_task(
        "task-1", None, None, None, "default", progress_callback=progress
    )

    assert result == {"done": 0, "failed": 1}
    service.clip_repo.update_clip.assert_not_awaited()
    assert steps == [(0, 1)]
    assert source.closed
