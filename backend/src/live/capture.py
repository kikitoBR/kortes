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


class LiveNotOnAir(RuntimeError):
    pass


@dataclass
class LiveStream:
    title: str
    is_live: bool
    inputs: List[Dict[str, Any]] = field(default_factory=list)
    video_id: Optional[str] = None


def live_embed(url: str, video_id: Optional[str] = None) -> Optional[Dict[str, str]]:
    """What the page needs to show the live and its chat (official embeds)."""
    platform = live_platform(url)
    if platform is None:
        return None
    if platform == "youtube":
        video_id = video_id or get_youtube_video_id(url)
        return {"platform": "youtube", "video_id": video_id} if video_id else None
    parts = [p for p in (urlparse(url.strip()).path or "").split("/") if p]
    channel = re.sub(r"[^A-Za-z0-9_-]", "", parts[0]) if parts else ""
    if not channel or channel.lower() in {"popout", "videos", "directory", "embed"}:
        return None
    return {"platform": platform, "channel": channel}


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
    video_id = info.get("id") if live_platform(url) == "youtube" else None
    return LiveStream(title=title or "Live", is_live=is_live, inputs=inputs, video_id=video_id)


def _input_args(item: Dict[str, Any], *, realtime: bool = True, newest: bool = False) -> List[str]:
    """ffmpeg input options for one stream address (or a local file, for tests)."""
    url = str(item["url"])
    if Path(url).exists():
        return (["-re"] if realtime else []) + ["-i", url]
    args: List[str] = []
    headers = "".join(f"{k}: {v}\r\n" for k, v in (item.get("headers") or {}).items())
    if headers:
        args += ["-headers", headers]
    proxy = get_config().ytdlp_proxy
    if proxy and proxy.startswith("http"):
        args += ["-http_proxy", proxy]
    if re.search(r"\.m3u8|manifest", url, re.I):
        if newest:
            args += ["-live_start_index", "-1"]
    else:
        args += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
    return args + ["-i", url]


def grab_live_frame(url: str) -> bytes:
    """A JPEG of what the live shows right now (for marking the webcam)."""
    stream = probe_live(url)
    if not stream.is_live or not stream.inputs:
        raise LiveNotOnAir(url)
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
         *_input_args(stream.inputs[0], realtime=False, newest=True),
         "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
        capture_output=True, timeout=60,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError((result.stderr or b"").decode(errors="replace")[-300:] or "no frame")
    return result.stdout


def recorder_command(
    inputs: Sequence[Dict[str, Any]], pieces_dir: Path, prefix: str, piece_seconds: int,
    *, realtime: bool = True,
) -> List[str]:
    """ffmpeg reading the stream (or a local file, for tests) into pieces."""
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    for item in inputs:
        command += _input_args(item, realtime=realtime)
    audio_input = 1 if len(inputs) > 1 else 0
    return command + [
        # YouTube lives come as separate video and audio streams, each opened at
        # its own point of the live; by default ffmpeg starts both at zero and the
        # voice drifts seconds from the picture. Their own timestamps share the
        # stream's clock, so keeping them keeps the two in sync.
        "-copyts",
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


def is_youtube_live_link(url: str) -> bool:
    """youtube.com/@channel/live or youtube.com/live/<id>: always a live."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return host.endswith("youtube.com") and re.search(r"/live(/|$)", parsed.path or "") is not None
