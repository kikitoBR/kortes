"""Where a clip's picture comes from when it is rendered or rendered again.

Clip timing (word timings, sentence snapping, cleanup cuts, the hook teaser)
only needs the source's transcript cache, which also records the source's
duration and voice energy. So a clip of a long YouTube video is timed against
that cache and takes its picture from a downloaded section of a few minutes,
never from the whole multi-hour file. Uploads keep using their local file.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, Tuple

from ..config import get_config
from ..media.ffmpeg import known_source_duration
from ..media.transcription import update_transcript_cache
from ..media_storage import MediaStorage
from ..utils.async_helpers import run_in_thread
from ..youtube_sections import download_youtube_section
from ..youtube_utils import cleanup_downloaded_files, get_youtube_video_id

logger = logging.getLogger(__name__)

RenderSource = Tuple[Path, float]


class ClipSource:
    """A timing path plus, for YouTube, sections fetched on demand."""

    def __init__(self, timing_path: Path, url: Optional[str] = None, sections: bool = False):
        self.timing_path = Path(timing_path)
        self.url = url
        self.sections = sections and bool(url)
        self.full_video: Optional[Path] = None
        self.downloaded_full = False

    @property
    def video_id(self) -> Optional[str]:
        return get_youtube_video_id(self.url) if self.url else None

    @classmethod
    async def for_task(
        cls, video_service, source_url: str, source_type: str, cached_video_path: Optional[str] = None
    ) -> "ClipSource":
        """Source for editing a clip after its task finished."""
        storage = MediaStorage()
        if cached_video_path:
            local = await run_in_thread(storage.local_path, cached_video_path)
            if local and Path(local).exists():
                return cls(Path(local))
        if source_type != "youtube":
            local = await run_in_thread(video_service.resolve_local_video_path, source_url)
            if not local.exists():
                raise ValueError("O arquivo do vídeo original não existe mais")
            return cls(local)
        video_id = get_youtube_video_id(source_url)
        if not video_id:
            raise ValueError("Link do YouTube inválido")
        nominal = Path(get_config().temp_dir) / f"{video_id}.mp4"
        if nominal.exists():
            return cls(nominal)
        await run_in_thread(storage.restore_youtube_metadata, video_id, nominal)
        source = cls(nominal, source_url, sections=get_config().youtube_partial_download)
        if not source.sections:
            await source._download_full()
        return source

    async def _download_full(self) -> Path:
        from .video_service import VideoService

        downloaded = await VideoService.download_video(self.url)
        if not downloaded:
            raise ValueError("Não foi possível baixar o vídeo original")
        self.full_video = Path(downloaded)
        self.downloaded_full = True
        if self.timing_path.suffix != ".m4a":
            # Edits after the task: the full video now is the timing source too.
            self.timing_path = self.full_video
        return self.full_video

    async def render_source(self, start: float, end: float) -> Optional[RenderSource]:
        """Picture for [start, end] of the source; None means use timing_path itself."""
        if self.full_video:
            return (self.full_video, 0.0)
        if not self.sections:
            return None
        section = await run_in_thread(download_youtube_section, self.url, start, end)
        if section:
            path, offset, duration = section
            if duration and not known_source_duration(self.timing_path):
                update_transcript_cache(self.timing_path, source_duration=duration)
            return (path, offset)
        logger.warning("Section download failed; downloading the whole video once")
        full = await self._download_full()
        return (full, 0.0)

    def release(self, render_source: Optional[RenderSource]) -> None:
        """Delete a section file once its clip is rendered."""
        if not render_source:
            return
        path = Path(render_source[0])
        if path != self.full_video and path.parent.name == "sections":
            path.unlink(missing_ok=True)

    def close(self, delete_full: bool = True) -> None:
        if self.downloaded_full and delete_full and self.full_video and self.video_id:
            try:
                MediaStorage().save_youtube_metadata(self.video_id, self.full_video)
            except Exception:
                logger.warning("Could not back up word timings before cleanup")
            cleanup_downloaded_files(self.video_id, source_path=self.full_video)
