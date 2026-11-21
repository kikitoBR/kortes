"""The assembly show: the clip really being made, step by step, for the page.

While a clip renders, its state is published (Redis key + SSE "show" event):

  momento        the moment the AI picked (times, title)
  cortes         the cuts (teaser and body ranges) and every word with its time
  trecho         the minutes of the source being downloaded
  enquadramento  a light preview of the real cut (and a filmstrip of its frames)
                 plus where the webcam and the game were found in it
  render         the final encode (layout, captions, title, loudness)
  revisao        the AI review
  pronto         the finished clip

The state is kept so a page opened mid-render shows the clip being made and
the queue behind it. Preview files live in TEMP_DIR/show/<task>/<clip> and are
removed when the next clip starts and when the task ends.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import get_config

logger = logging.getLogger(__name__)

SHOW_TTL_SECONDS = 6 * 3600
STRIP_SECONDS_PER_FRAME = 2.5
STRIP_MIN_FRAMES, STRIP_MAX_FRAMES = 8, 40
PREVIEW_HEIGHT = 480


def show_dir(task_id: str) -> Path:
    safe = "".join(ch for ch in str(task_id) if ch.isalnum() or ch == "-")
    return Path(get_config().temp_dir) / "show" / safe


def show_key(task_id: str) -> str:
    return f"show:{task_id}"


def teaser_count(ranges: Sequence[Tuple[float, float]]) -> int:
    """Ranges that play first but happen later (the hook teaser and its rewind)."""
    if len(ranges) < 2:
        return 0
    first = ranges[0][0]
    return next((i for i in range(1, len(ranges)) if ranges[i][0] < first), 0)


def caption_words_per_line(template_name: Optional[str]) -> int:
    """Words per caption line, as the render groups them."""
    from .caption_templates import get_template

    try:
        return max(1, int(get_template(template_name or "default").get("max_words_per_line", 4) or 4))
    except Exception:
        return 4


def strip_frame_count(duration: float) -> int:
    return int(min(STRIP_MAX_FRAMES, max(STRIP_MIN_FRAMES, round(duration / STRIP_SECONDS_PER_FRAME))))


def make_preview_assets(source_clip: Path, out_dir: Path) -> Dict[str, Any]:
    """A light, silent copy of the real cut and a strip of its frames."""
    out_dir.mkdir(parents=True, exist_ok=True)
    preview = out_dir / "preview.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(source_clip), "-an",
         "-vf", f"scale=-2:{PREVIEW_HEIGHT}", "-c:v", "libx264", "-preset", "ultrafast",
         "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(preview)],
        check=True, capture_output=True, timeout=300,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height",
         "-of", "json", str(preview)],
        capture_output=True, text=True, timeout=60,
    )
    info = json.loads(probe.stdout or "{}")
    duration = float((info.get("format") or {}).get("duration") or 0) or 1.0
    stream = (info.get("streams") or [{}])[0]
    strip = out_dir / "strip.jpg"
    frames = strip_frame_count(duration)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(preview),
         "-vf", f"fps={frames / duration:.5f},scale=160:-2,tile={frames}x1",
         "-frames:v", "1", "-q:v", "5", str(strip)],
        check=True, capture_output=True, timeout=120,
    )
    return {
        "preview_size": [stream.get("width"), stream.get("height")],
        "strip_frames": frames,
    }


class ShowReporter:
    """Keeps and publishes one task's show state (safe to call from threads)."""

    def __init__(self, redis, task_id: str):
        self.redis = redis
        self.task_id = task_id
        self.loop = asyncio.get_running_loop()
        self.state: Dict[str, Any] = {"clip": None, "queue": []}
        self.clip_key: Optional[str] = None

    @property
    def clip_dir(self) -> Optional[Path]:
        return show_dir(self.task_id) / self.clip_key if self.clip_key else None

    def asset_url(self, name: str) -> str:
        return f"/tasks/{self.task_id}/show/{self.clip_key}/{name}"

    async def _publish(self) -> None:
        self.state["updated"] = time.time()
        payload = json.dumps(self.state, default=str)
        try:
            await self.redis.setex(show_key(self.task_id), SHOW_TTL_SECONDS, payload)
            await self.redis.publish(
                f"progress:{self.task_id}",
                json.dumps({"task_id": self.task_id, "event_type": "show", "show": self.state}, default=str),
            )
        except Exception:
            logger.debug("Show state publish failed", exc_info=True)

    async def start_clip(self, index: int, total: int, segment: Dict[str, Any], layout: str) -> None:
        old = self.clip_dir
        self.clip_key = f"c{index + 1:03d}-{uuid.uuid4().hex[:8]}"
        if old:
            shutil.rmtree(old, ignore_errors=True)
        self.state["clip"] = {
            "key": self.clip_key,
            "index": index,
            "total": total,
            "stage": "momento",
            "start_time": segment.get("start_time"),
            "end_time": segment.get("end_time"),
            "title": segment.get("hook_title"),
            "layout": layout,
        }
        await self._publish()

    async def clip(self, **fields: Any) -> None:
        if self.state.get("clip") is None:
            return
        self.state["clip"].update(fields)
        await self._publish()

    def clip_threadsafe(self, **fields: Any) -> None:
        """For the render threads: hand the update to the event loop and move on."""
        try:
            asyncio.run_coroutine_threadsafe(self.clip(**fields), self.loop)
        except Exception:
            logger.debug("Show update from thread failed", exc_info=True)

    async def set_queue(self, items: List[Dict[str, Any]]) -> None:
        self.state["queue"] = items
        await self._publish()

    async def finish(self) -> None:
        try:
            await self.redis.delete(show_key(self.task_id))
        except Exception:
            pass
        shutil.rmtree(show_dir(self.task_id), ignore_errors=True)


async def read_show_state(redis, task_id: str) -> Dict[str, Any]:
    raw = await redis.get(show_key(task_id))
    if not raw:
        return {"clip": None, "queue": []}
    try:
        return json.loads(raw)
    except ValueError:
        return {"clip": None, "queue": []}
