"""Live capture: find a live stream and record it in short pieces.

The recorder only copies the stream (no re-encoding, ~1-2% CPU) into pieces
of LIVE_PIECE_SECONDS. Pieces are deleted a few minutes after the AI has read
them; the minutes around each clip are joined into one small archive file.

Approach adapted from SHARINGAN's live agent (src/aovivo/agente.ts; MIT
licence, (c) 2026 the SHARINGAN authors), with a rolling buffer instead of
keeping the whole stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse

import yt_dlp

from ..config import get_config
from ..youtube_utils import apply_ytdlp_network_options, get_youtube_video_id

logger = logging.getLogger(__name__)

LIVE_PLATFORM_HOSTS = ("twitch.tv", "kick.com")


def live_platform(url: str) -> Optional[str]:
    """"youtube", "twitch" or "kick" for links that can carry a live stream."""
    try:
        host = (urlparse(url.strip()).hostname or "").lower()
    except ValueError:
        return None
    if get_youtube_video_id(url) or host.endswith("youtube.com"):
        return "youtube"
    for platform in LIVE_PLATFORM_HOSTS:
        if host == platform or host.endswith("." + platform):
            return platform.split(".")[0]
    return None


def live_format_selector() -> str:
    height = get_config().live_max_height
    cap = f"[height<=?{height}]" if height else ""
    return f"bv*{cap}[vcodec^=avc1]+ba/bv*{cap}+ba/b{cap}/b"


@dataclass
class LiveStream:
    title: str
    is_live: bool
    inputs: List[Dict[str, Any]] = field(default_factory=list)


def probe_live(url: str) -> LiveStream:
    """Ask yt-dlp whether the link is live now and where its stream is."""
    options = apply_ytdlp_network_options(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "format": live_format_selector(),
            "socket_timeout": 30,
        }
    )
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    is_live = bool(info.get("is_live")) or info.get("live_status") == "is_live"
    formats = info.get("requested_formats") or ([info] if info.get("url") else [])
    inputs = [
        {"url": fmt["url"], "headers": fmt.get("http_headers") or info.get("http_headers") or {}}
        for fmt in formats[:2]
        if fmt.get("url")
    ]
    title = str(info.get("title") or info.get("uploader") or "Live").strip()
    # YouTube appends the start date to live titles; drop it.
    title = re.sub(r"\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", "", title)[:500]
    return LiveStream(title=title or "Live", is_live=is_live, inputs=inputs)


def recorder_command(
    inputs: Sequence[Dict[str, Any]], pieces_dir: Path, prefix: str, piece_seconds: int,
    *, realtime: bool = True,
) -> List[str]:
    """ffmpeg reading the stream (or a local file, for tests) into pieces."""
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    proxy = get_config().ytdlp_proxy
    for item in inputs:
        url = str(item["url"])
        if Path(url).exists():
            command += (["-re"] if realtime else []) + ["-i", url]
            continue
        headers = "".join(f"{k}: {v}\r\n" for k, v in (item.get("headers") or {}).items())
        if headers:
            command += ["-headers", headers]
        if proxy and proxy.startswith("http"):
            command += ["-http_proxy", proxy]
        if not re.search(r"\.m3u8|manifest", url, re.I):
            command += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
        command += ["-i", url]
    audio_input = 1 if len(inputs) > 1 else 0
    return command + [
        "-map", "0:v:0?", "-map", f"{audio_input}:a:0?", "-c", "copy",
        "-f", "segment", "-segment_time", str(piece_seconds),
        "-segment_format", "mpegts", "-reset_timestamps", "0",
        str(pieces_dir / f"{prefix}%06d.ts"),
    ]


class PieceRecorder:
    """Runs the recording ffmpeg and lists the pieces it has finished."""

    def __init__(self, command: List[str], pieces_dir: Path, prefix: str):
        self.command = command
        self.pieces_dir = pieces_dir
        self.prefix = prefix
        self.process: Optional[asyncio.subprocess.Process] = None
        self.error = ""
        self._reader: Optional[asyncio.Task] = None

    async def start(self) -> None:
        self.pieces_dir.mkdir(parents=True, exist_ok=True)
        self.process = await asyncio.create_subprocess_exec(
            *self.command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        self._reader = asyncio.create_task(self._read_errors())

    async def _read_errors(self) -> None:
        if not self.process or not self.process.stderr:
            return
        async for line in self.process.stderr:
            self.error = (self.error + line.decode(errors="replace"))[-800:]

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def pieces(self) -> List[Path]:
        return sorted(self.pieces_dir.glob(f"{self.prefix}*.ts"))

    def closed_pieces(self) -> List[Path]:
        """Finished pieces; while recording, the newest is still being written."""
        pieces = self.pieces()
        return pieces[:-1] if self.running else pieces

    async def stop(self) -> None:
        if not self.running:
            return
        self.process.terminate()  # ffmpeg closes the current piece cleanly
        try:
            await asyncio.wait_for(self.process.wait(), timeout=15)
        except asyncio.TimeoutError:
            self.process.kill()
            await self.process.wait()


def probe_piece(path: Path) -> Dict[str, float]:
    """Start, duration and audio start (seconds on the stream clock) of a piece."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=start_time,duration:stream=codec_type,start_time",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, timeout=60,
    )
    payload = json.loads(result.stdout or "{}")
    fmt = payload.get("format") or {}
    start = float(fmt.get("start_time") or 0.0)
    audio = next(
        (s for s in payload.get("streams") or [] if s.get("codec_type") == "audio" and s.get("start_time") not in (None, "N/A")),
        None,
    )
    return {
        "start": start,
        "duration": float(fmt.get("duration") or 0.0),
        "audio_start": float(audio["start_time"]) if audio else start,
        "has_audio": audio is not None,
    }


def extract_piece_audio(piece: Path, output: Path) -> bool:
    """Small mono AAC of a piece (transcription, voice energy, the live's audio)."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(piece), "-map", "0:a:0", "-vn",
         "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(output)],
        capture_output=True, text=True, timeout=300,
    )
    return result.returncode == 0 and output.exists() and output.stat().st_size > 0


def join_pieces(pieces: Sequence[Path], output: Path) -> bool:
    """One archive file from consecutive pieces, as recorded (no re-encoding)."""
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", "concat:" + "|".join(str(p) for p in pieces),
         "-map", "0", "-c", "copy", str(output)],
        capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        logger.warning("Joining live pieces failed: %s", (result.stderr or "")[-300:])
    return result.returncode == 0 and output.exists()
