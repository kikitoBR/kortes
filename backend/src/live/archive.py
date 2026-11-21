"""Where a live task keeps its files, and the clip source its edits use.

Layout under TEMP_DIR/live/<task_id>/:
  pieces/          the rolling buffer (deleted minutes after being read)
  audio/           the live's audio, one small AAC per piece
  archive/         the minutes around each clip, kept LIVE_ARCHIVE_DAYS
  archive.json     [{path, start, end}] on the live clock (seconds)
  live.transcript_cache.json   words, duration and voice energy on that clock
  state.json       the recorder's progress, so a restarted worker resumes

Clips are timed against "live.mp4", which never exists: like a YouTube source
analysed from its audio, every helper reads the transcript cache next to it,
and the picture comes from the archive file that covers the clip.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config import get_config

logger = logging.getLogger(__name__)


def live_dir(task_id: str) -> Path:
    safe = "".join(ch for ch in str(task_id) if ch.isalnum() or ch == "-")
    return Path(get_config().temp_dir) / "live" / safe


def timing_path(task_id: str) -> Path:
    return live_dir(task_id) / "live.mp4"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload))
    temporary.replace(path)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def archive_entries(task_id: str) -> List[Dict[str, Any]]:
    return read_json(live_dir(task_id) / "archive.json", [])


def add_archive_entry(task_id: str, path: Path, start: float, end: float) -> None:
    entries = archive_entries(task_id)
    entries.append({"path": path.name, "start": round(start, 3), "end": round(end, 3)})
    write_json(live_dir(task_id) / "archive.json", entries)


def archive_covering(task_id: str, start: float, end: float) -> Optional[Tuple[Path, float]]:
    """The archive file holding [start, end] on the live clock, with its start."""
    directory = live_dir(task_id) / "archive"
    for entry in sorted(archive_entries(task_id), key=lambda e: e["end"] - e["start"]):
        path = directory / entry["path"]
        if entry["start"] <= start + 0.05 and entry["end"] >= end - 0.05 and path.exists():
            return path, float(entry["start"])
    return None


class LiveClipSource:
    """ClipSource for a live task: times clips from the live's transcript cache
    and takes the picture from the archive file that covers them."""

    def __init__(self, task_id: str):
        self.task_id = task_id
        self.timing_path = timing_path(task_id)
        self.full_video = None
        self.sections = False

    async def render_source(self, start: float, end: float) -> Tuple[Path, float]:
        found = archive_covering(self.task_id, start, end)
        if not found:
            raise ValueError(
                "Esse trecho da live não foi guardado. Só os minutos em volta de cada corte "
                f"ficam disponíveis para edição (por {get_config().live_archive_days} dias)."
            )
        return found

    def release(self, render_source) -> None:
        """Archive files stay for later edits."""

    def close(self, delete_full: bool = True) -> None:
        """Nothing downloaded to clean up."""


def remove_live_files(task_id: str) -> None:
    shutil.rmtree(live_dir(task_id), ignore_errors=True)


def purge_expired_live_archives(now: Optional[float] = None) -> int:
    """Delete finished lives' files after LIVE_ARCHIVE_DAYS without changes."""
    root = Path(get_config().temp_dir) / "live"
    if not root.exists():
        return 0
    cutoff = (now or time.time()) - get_config().live_archive_days * 86400
    removed = 0
    for directory in root.iterdir():
        state = read_json(directory / "state.json", {})
        if not directory.is_dir() or not state.get("finished"):
            continue
        try:
            newest = max((p.stat().st_mtime for p in directory.rglob("*")), default=directory.stat().st_mtime)
        except OSError:
            continue
        if newest < cutoff:
            shutil.rmtree(directory, ignore_errors=True)
            removed += 1
    if removed:
        logger.info("Removed %d expired live archive(s)", removed)
    return removed
