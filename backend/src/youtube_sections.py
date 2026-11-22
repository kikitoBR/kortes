"""YouTube partial downloads: the audio for analysis, then only the clip sections.

A multi-hour live stream used to be downloaded whole before anything else could
start. Here only the audio comes down first (transcription, voice energy and the
AI only need sound), and each clip later fetches just the minutes it shows.

Fast path ported from SHARINGAN (src/cortes/baixar-rapido.ts; MIT licence,
(c) 2026 the SHARINGAN authors): read the file's index (the mp4 "sidx" box,
where every ~5 s fragment starts) and fetch only the header plus the fragments
of the requested part, in 10 MB blocks over several connections. Anything
unexpected raises, and the callers fall back to a slower, exact ffmpeg cut and
finally to the whole video.
"""

from __future__ import annotations

import logging
import shutil
import struct
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
import yt_dlp

from .config import get_config
from .youtube_utils import (
    _note_bot_check,
    apply_ytdlp_network_options,
    get_youtube_video_id,
)

logger = logging.getLogger(__name__)

BLOCK_BYTES = 10 << 20  # the block size YouTube does not throttle
CONNECTIONS = 6
HEADER_BYTES = 256 << 10
SECTION_PADDING_SECONDS = 2.0


class SectionDownloadError(RuntimeError):
    pass


def _format_limits() -> str:
    config = get_config()
    limits = ""
    if config.ytdlp_max_height:
        limits += f"[height<=?{config.ytdlp_max_height}]"
    if config.ytdlp_max_fps:
        limits += f"[fps<=?{config.ytdlp_max_fps}]"
    return limits


def section_format_selector() -> str:
    # mp4/m4a over plain https: the fast path needs the sidx index those files
    # carry. A finished live also lists HLS copies ("m3u8", often VP9 sliced
    # from WebM) that yt-dlp ranks higher; ffmpeg cannot seek into those (the
    # cut came out with no picture), so they are only a last resort.
    limits = _format_limits()
    return (
        f"bestvideo[ext=mp4][protocol=https]{limits}+bestaudio[ext=m4a][protocol=https]/"
        f"bestvideo[protocol=https]{limits}+bestaudio[protocol=https]/"
        f"bestvideo[ext=mp4]{limits}+bestaudio[ext=m4a]/"
        f"bestvideo*{limits}+bestaudio/best{limits}"
    )


AUDIO_FORMAT_SELECTOR = "bestaudio[ext=m4a]/bestaudio"


def youtube_format_info(url: str, selector: str) -> Dict[str, Any]:
    """What yt-dlp would download (title, duration, each format's address)."""
    options = apply_ytdlp_network_options(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "format": selector,
            "socket_timeout": 30,
        }
    )
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(url, download=False) or {}
    except yt_dlp.utils.DownloadError as exc:
        _note_bot_check(get_youtube_video_id(url), exc)
        raise SectionDownloadError(str(exc)) from exc


def _chosen_formats(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    formats = info.get("requested_formats") or ([info] if info.get("url") else [])
    if not formats or len(formats) > 2:
        raise SectionDownloadError("unexpected format selection")
    return formats


def _session() -> requests.Session:
    session = requests.Session()
    proxy = get_config().ytdlp_proxy
    if proxy:
        # googlevideo links only work from the address that requested them.
        session.proxies = {"http": proxy, "https": proxy}
    return session


def _fetch(
    session: requests.Session,
    fmt: Dict[str, Any],
    start: int,
    end: int,
    attempts: int = 4,
    exact: bool = True,
) -> bytes:
    """Bytes [start, end] of a format; ``exact=False`` accepts a file that ends sooner."""
    url = fmt["url"]
    youtube = "googlevideo.com" in url
    headers = dict(fmt.get("http_headers") or {})
    if not youtube:
        headers["Range"] = f"bytes={start}-{end}"
    for attempt in range(attempts + 1):
        try:
            # YouTube takes the range in the address itself.
            response = session.get(
                f"{url}&range={start}-{end}" if youtube else url,
                headers=headers,
                timeout=60,
            )
            if response.status_code not in (200, 206):
                raise SectionDownloadError(f"HTTP {response.status_code}")
            data = response.content
            if not data or (exact and len(data) != end - start + 1) or len(data) > end - start + 1:
                raise SectionDownloadError(f"got {len(data)} of {end - start + 1} bytes")
            return data
        except (requests.RequestException, SectionDownloadError):
            if attempt >= attempts:
                raise
            time.sleep(0.8 * (attempt + 1))
    raise SectionDownloadError("unreachable")


def _boxes(data: bytes) -> List[Tuple[str, int, int]]:
    boxes = []
    offset = 0
    while offset + 8 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4 : offset + 8].decode("latin1")
        if size == 1:
            if offset + 16 > len(data):
                break
            size = struct.unpack_from(">Q", data, offset + 8)[0]
        if size < 8:
            break
        boxes.append((kind, offset, offset + size))
        offset += size
    return boxes


def sidx_fragments(data: bytes, start: int, end: int) -> List[Tuple[float, float, int, int]]:
    """(start s, end s, first byte, end byte) of every fragment a sidx box lists."""
    offset = start + 8
    version = data[offset]
    offset += 4 + 4  # version/flags, reference_ID
    timescale = struct.unpack_from(">I", data, offset)[0]
    offset += 4
    if version == 0:
        ticks, first = struct.unpack_from(">II", data, offset)
        offset += 8
    else:
        ticks, first = struct.unpack_from(">QQ", data, offset)
        offset += 16
    offset += 2
    count = struct.unpack_from(">H", data, offset)[0]
    offset += 2
    byte = end + first
    fragments = []
    for _ in range(count):
        size, duration = struct.unpack_from(">II", data, offset)
        size &= 0x7FFFFFFF
        fragments.append((ticks / timescale, (ticks + duration) / timescale, byte, byte + size))
        ticks += duration
        byte += size
        offset += 12
    return fragments


@dataclass
class _Plan:
    fmt: Dict[str, Any]
    path: Path
    ranges: List[Tuple[int, int]]

    @property
    def size(self) -> int:
        return sum(end - start + 1 for start, end in self.ranges)


def _plan(session, fmt: Dict[str, Any], path: Path, window: Optional[Tuple[float, float]]) -> _Plan:
    if not str(fmt.get("protocol") or "https").startswith("http") or not fmt.get("url"):
        raise SectionDownloadError(f"format protocol {fmt.get('protocol')} cannot be fetched in blocks")
    head_end = HEADER_BYTES - 1
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    if size:
        head_end = min(head_end, int(size) - 1)
    header = _fetch(session, fmt, 0, head_end, exact=False)
    boxes = _boxes(header)
    moov = next((b for b in boxes if b[0] == "moov"), None)
    sidx = next((b for b in boxes if b[0] == "sidx"), None)
    if not moov or not sidx or sidx[2] > len(header):
        raise SectionDownloadError("no index at the start of the file")
    fragments = sidx_fragments(header, sidx[1], sidx[2])
    wanted = [i for i, f in enumerate(fragments) if window is None or (f[1] > window[0] and f[0] < window[1])]
    if not wanted:
        raise SectionDownloadError("the requested part is outside the video")
    # Header (ftyp + moov), the first fragment and the fragments of the part.
    # Keeping the first fragment gives the part the same start as the whole
    # file, so it lines up with the source clock exactly like a full download
    # (each track is aligned by its own start). The sidx is left out because
    # its byte offsets would no longer match.
    ranges = [(0, moov[2] - 1)]
    if wanted[0] > 0:
        ranges.append((fragments[0][2], fragments[0][3] - 1))
    ranges.append((fragments[wanted[0]][2], fragments[wanted[-1]][3] - 1))
    return _Plan(fmt, path, ranges)


def _download(session, plans: List[_Plan]) -> None:
    jobs = []
    for plan in plans:
        position = 0
        for start, end in plan.ranges:
            for block in range(start, end + 1, BLOCK_BYTES):
                block_end = min(end, block + BLOCK_BYTES - 1)
                jobs.append((plan, block, block_end, position))
                position += block_end - block + 1
    handles = {id(plan): plan.path.open("wb") for plan in plans}
    locks = {id(plan): threading.Lock() for plan in plans}
    try:
        def run(job):
            plan, start, end, position = job
            data = _fetch(session, plan.fmt, start, end)
            with locks[id(plan)]:
                handle = handles[id(plan)]
                handle.seek(position)
                handle.write(data)

        with ThreadPoolExecutor(max_workers=CONNECTIONS) as pool:
            for future in [pool.submit(run, job) for job in jobs]:
                future.result()
    finally:
        for handle in handles.values():
            handle.close()


def _ffmpeg(args: List[str], timeout: int = 900) -> None:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-y", *args],
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise SectionDownloadError((result.stderr or "ffmpeg failed").strip()[-400:])


def _fast_download(info: Dict[str, Any], window: Optional[Tuple[float, float]], work: Path, output: Path) -> float:
    """Download the part through the index.

    Returns the source second the output's clock starts at: 0, because the
    part keeps the whole file's timeline (seek straight to source seconds).
    """
    formats = _chosen_formats(info)
    session = _session()
    plans = [
        _plan(session, fmt, work / f"part{i}.{fmt.get('ext') or 'mp4'}", window)
        for i, fmt in enumerate(formats)
    ]
    started = time.monotonic()
    _download(session, plans)
    logger.info(
        "Fetched %d MB through the index in %.1fs",
        sum(p.size for p in plans) >> 20, time.monotonic() - started,
    )
    # Merged the way yt-dlp merges a full download, so timestamps match it.
    inputs: List[str] = []
    for plan in plans:
        inputs += ["-i", str(plan.path)]
    if len(plans) == 1:
        maps = ["-map", "0"]
    else:
        video_index = next(
            (i for i, p in enumerate(plans) if (p.fmt.get("vcodec") or "none") != "none"), 0
        )
        maps = ["-map", f"{video_index}:v:0", "-map", f"{1 - video_index}:a:0"]
    _ffmpeg([*inputs, *maps, "-c", "copy", str(output)])
    return 0.0


def _exact_cut(info: Dict[str, Any], window: Tuple[float, float], output: Path) -> float:
    """Slower fallback: let ffmpeg seek each remote track and re-encode the part,
    which makes the first frame land exactly on the requested second."""
    formats = _chosen_formats(info)
    proxy = get_config().ytdlp_proxy
    args: List[str] = []
    for fmt in formats:
        headers = "".join(f"{k}: {v}\r\n" for k, v in (fmt.get("http_headers") or {}).items())
        if headers:
            args += ["-headers", headers]
        if proxy and proxy.startswith("http"):
            args += ["-http_proxy", proxy]
        args += ["-ss", f"{window[0]:.3f}", "-i", fmt["url"]]
    video_index = next(
        (i for i, f in enumerate(formats) if (f.get("vcodec") or "none") != "none"), 0
    )
    audio_index = next(
        (i for i, f in enumerate(formats) if (f.get("acodec") or "none") != "none"), video_index
    )
    _ffmpeg(
        [*args, "-t", f"{window[1] - window[0]:.3f}", "-map", f"{video_index}:v:0",
         "-map", f"{audio_index}:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
         str(output)],
        timeout=1800,
    )
    # ffmpeg can "succeed" with no picture at all (it dropped every frame while
    # seeking a stream it cannot seek): that is a failed cut, not a section.
    if not _has_video_frames(output):
        raise SectionDownloadError("the cut has no picture")
    return window[0]


def _has_video_frames(path: Path) -> bool:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    try:
        return int((result.stdout or "0").strip().splitlines()[0]) > 0
    except (ValueError, IndexError):
        return False


def download_youtube_section(
    url: str, start: float, end: float, output_dir: Optional[Path] = None
) -> Optional[Tuple[Path, float, Optional[float]]]:
    """Download only [start, end] of a YouTube video.

    Returns (file, source second the file starts at, source duration) or None.
    """
    video_id = get_youtube_video_id(url) or "video"
    directory = Path(output_dir or Path(get_config().temp_dir) / "sections")
    directory.mkdir(parents=True, exist_ok=True)
    window = (max(0.0, start - SECTION_PADDING_SECONDS), end + SECTION_PADDING_SECONDS)
    # Matroska keeps the part's timestamps as they are (the gap after the
    # first fragment included).
    output = directory / f"{video_id}-{uuid.uuid4().hex[:12]}.mkv"
    work = directory / f".work-{output.stem}"
    try:
        info = youtube_format_info(url, section_format_selector())
    except Exception as exc:
        logger.warning("Section download: no format info for %s: %s", video_id, exc)
        return None
    duration = float(info["duration"]) if info.get("duration") else None
    attempts = (
        ("index", lambda: _fast_download(info, window, work, output)),
        ("exact cut", lambda: _exact_cut(info, window, output)),
    )
    for name, run in attempts:
        work.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        try:
            offset = run()
            logger.info(
                "Downloaded %s %.0f-%.0fs (%s) in %.1fs",
                video_id, window[0], window[1], name, time.monotonic() - started,
            )
            return output, offset, duration
        except Exception as exc:
            logger.warning("Section download (%s) failed for %s: %s", name, video_id, exc)
            output.unlink(missing_ok=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return None


def download_youtube_audio(url: str) -> Optional[Path]:
    """Audio-only download (<video_id>.m4a, next to where the video would go).

    Sharing the video's file stem keeps the transcript cache shared too.
    """
    video_id = get_youtube_video_id(url)
    if not video_id:
        return None
    temp_dir = Path(get_config().temp_dir)
    output = temp_dir / f"{video_id}.m4a"
    work = temp_dir / f".audio-{video_id}-{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        try:
            info = youtube_format_info(url, AUDIO_FORMAT_SELECTOR)
            if (info.get("ext") or "") != "m4a":
                raise SectionDownloadError("audio is not m4a")
            _fast_download(info, None, work, output)  # whole file: header + every fragment
            method = "index"
        except Exception as exc:
            logger.info("Fast audio download unavailable for %s (%s); using yt-dlp", video_id, exc)
            options = apply_ytdlp_network_options(
                {
                    "format": AUDIO_FORMAT_SELECTOR,
                    "outtmpl": str(work / f"{video_id}.%(ext)s"),
                    "quiet": True,
                    "noplaylist": True,
                    "overwrites": True,
                    "socket_timeout": 30,
                    "retries": 5,
                    "http_chunk_size": BLOCK_BYTES,
                }
            )
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    ydl.download([url])
            except yt_dlp.utils.DownloadError as error:
                _note_bot_check(video_id, error)
                logger.warning("Audio download failed for %s: %s", video_id, error)
                return None
            downloaded = next((p for p in work.glob(f"{video_id}.*") if p.is_file()), None)
            if not downloaded:
                return None
            codec = ["-c:a", "copy"] if downloaded.suffix == ".m4a" else ["-c:a", "aac", "-b:a", "160k"]
            _ffmpeg(["-i", str(downloaded), "-vn", *codec, "-movflags", "+faststart", str(output)])
            method = "yt-dlp"
        logger.info(
            "Audio of %s downloaded (%s, %d MB) in %.1fs",
            video_id, method, output.stat().st_size >> 20, time.monotonic() - started,
        )
        return output
    except Exception as exc:
        logger.warning("Audio download failed for %s: %s", video_id, exc)
        output.unlink(missing_ok=True)
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)
