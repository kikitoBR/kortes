import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from src.media.ffmpeg import ffprobe_duration
from src.services.clip_source import ClipSource

URL = "https://www.youtube.com/watch?v=abc123DEF45"


def timing(tmp_path, **extra):
    path = tmp_path / "abc123DEF45.mp4"
    path.with_suffix(".transcript_cache.json").write_text(json.dumps({"words": [], **extra}))
    return path


def test_duration_comes_from_the_transcript_cache_when_the_media_is_gone(tmp_path):
    path = timing(tmp_path, source_duration=14400.5)
    assert ffprobe_duration(path) == 14400.5


@pytest.mark.asyncio
async def test_each_clip_takes_its_own_section_and_releases_it(tmp_path):
    path = timing(tmp_path)
    sections = tmp_path / "sections"
    sections.mkdir()
    section = sections / "abc.mkv"
    section.write_bytes(b"x")
    source = ClipSource(path, URL, sections=True)
    with patch("src.services.clip_source.download_youtube_section", return_value=(section, 0.0, 7200.0)) as fetch:
        render = await source.render_source(3600.0, 3660.0)
    fetch.assert_called_once_with(URL, 3600.0, 3660.0)
    assert render == (section, 0.0)
    # The source duration is now on record for later edits.
    assert json.loads(path.with_suffix(".transcript_cache.json").read_text())["source_duration"] == 7200.0
    source.release(render)
    assert not section.exists()


@pytest.mark.asyncio
async def test_a_failed_section_falls_back_to_one_full_download(tmp_path):
    path = timing(tmp_path)
    full = tmp_path / "abc123DEF45.full.mp4"
    full.write_bytes(b"x")
    source = ClipSource(path, URL, sections=True)
    download = AsyncMock(return_value=full)
    with patch("src.services.clip_source.download_youtube_section", return_value=None), patch(
        "src.services.video_service.VideoService.download_video", download
    ):
        assert await source.render_source(10.0, 70.0) == (full, 0.0)
        assert await source.render_source(100.0, 160.0) == (full, 0.0)
    download.assert_awaited_once()
    source.release((full, 0.0))
    assert full.exists()  # the shared full video is not a section


@pytest.mark.asyncio
async def test_uploads_render_from_their_own_file(tmp_path):
    video = tmp_path / "upload.mp4"
    video.write_bytes(b"x")
    source = ClipSource(video)
    assert await source.render_source(0, 10) is None
