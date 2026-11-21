"""Voice energy second by second, and the transcript marked where it peaks.

Shouting, celebrating, getting scared or a loud in-game moment all push the
volume well above the rest of a live stream, and those are usually its best
moments. Speech alone does not show them, so the transcript handed to the AI
carries a marker on each line where the volume jumps.

Ported from SHARINGAN (src/cortes/analisar.ts `medirEnergia`/`picos` and
src/cortes/escolher.ts `liveEmTexto`; MIT licence, (c) 2026 the SHARINGAN authors).
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import List, Optional, Sequence

from .common import logger
from .ffmpeg import run_ffmpeg_command, select_audio_stream_index
from .transcription import load_cached_transcript_data, update_transcript_cache

FLOOR_DB = -90.0
# Seconds quieter than this are silence and stay out of the average.
ALIVE_DB = -60.0
# Standard deviations above the video's average.
PEAK_Z = 1.5
STRONG_PEAK_Z = 2.5
GAP_PEAK_Z = 2.0
# Speechless stretches longer than this are shown, flagged when they get loud.
SILENT_GAP_SECONDS = 25

_RMS_RE = re.compile(r"RMS_level=(-?[\d.]+|-inf|inf|nan)")
_LINE_RE = re.compile(
    r"^\[(?P<start>\d{1,3}:\d{2}(?::\d{2})?)\s*-\s*(?P<end>\d{1,3}:\d{2}(?::\d{2})?)\]"
)


def _timestamp_seconds(value: str) -> float:
    total = 0.0
    for part in value.split(":"):
        total = total * 60 + float(part)
    return total


def _label(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def parse_rms_levels(output: str) -> List[float]:
    levels = []
    for match in _RMS_RE.finditer(output or ""):
        try:
            value = float(match.group(1))
        except ValueError:
            value = FLOOR_DB
        levels.append(FLOOR_DB if not math.isfinite(value) else max(FLOOR_DB, value))
    return levels


def measure_levels(media_path: Path) -> List[float]:
    """RMS level (dB) of every second of a file's audio, measured now."""
    if not Path(media_path).exists():
        return []
    stream = select_audio_stream_index(media_path)
    if stream is None:
        return []
    result = run_ffmpeg_command(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-i", str(media_path),
            "-map", f"0:a:{stream}", "-vn",
            "-af",
            # Resample first so every 16000-sample frame is exactly one second.
            "aresample=16000,aformat=channel_layouts=mono,asetnsamples=n=16000:p=0,"
            "astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
            "-f", "null", "-",
        ],
        timeout=1800,
    )
    if result.returncode != 0:
        logger.warning("Voice energy measurement failed for %s", media_path)
        return []
    return [round(v, 1) for v in parse_rms_levels(result.stdout)]


def measure_voice_energy(media_path: Path) -> List[float]:
    """RMS level (dB) of every second of the source's audio.

    Kept inside the transcript cache, so it is measured once per video and
    survives the cleanup of the downloaded media.
    """
    cached = (load_cached_transcript_data(media_path) or {}).get("voice_energy_db")
    if isinstance(cached, list) and cached:
        return [float(v) for v in cached]
    levels = measure_levels(media_path)
    if levels:
        update_transcript_cache(media_path, voice_energy_db=levels)
        logger.info("Measured voice energy: %d seconds", len(levels))
    return levels


def energy_zscores(levels: Sequence[float]) -> List[float]:
    """How many standard deviations above the video's average each second is."""
    alive = [v for v in levels if v > ALIVE_DB]
    if not alive:
        return [0.0 for _ in levels]
    mean = sum(alive) / len(alive)
    deviation = math.sqrt(sum((v - mean) ** 2 for v in alive) / len(alive)) or 1.0
    return [(v - mean) / deviation for v in levels]


def peak_level(z: Sequence[float], start: float, end: float) -> float:
    """Highest z-score of the seconds a [start, end) span touches."""
    first = max(0, int(math.floor(start)))
    last = min(len(z) - 1, max(first, int(math.ceil(end)) - 1))
    if not z or last < first:
        return float("-inf")
    return max(z[first : last + 1])


def peak_marker(level: float) -> str:
    if level >= STRONG_PEAK_Z:
        return "🔊🔊"
    if level >= PEAK_Z:
        return "🔊"
    return ""


def annotate_transcript(transcript: str, z: Optional[Sequence[float]]) -> str:
    """Mark transcript lines where the voice peaks; show loud speechless gaps.

    Lines keep their "[start - end] text" shape so the AI still picks real
    timestamps; gap notes use another shape so they are never picked as spans.
    """
    if not z:
        return transcript
    out: List[str] = []
    previous_end: Optional[float] = None
    for raw in transcript.splitlines():
        match = _LINE_RE.match(raw.strip())
        if not match:
            out.append(raw)
            continue
        start = _timestamp_seconds(match.group("start"))
        end = max(start, _timestamp_seconds(match.group("end")))
        if previous_end is not None and start - previous_end > SILENT_GAP_SECONDS:
            loud = peak_level(z, previous_end, start) >= GAP_PEAK_Z
            out.append(
                f"({_label(previous_end)} to {_label(start)}: no speech"
                f"{'; loud game sound somewhere here 🔊' if loud else ''})"
            )
        marker = peak_marker(peak_level(z, start, end))
        out.append(f"{raw.rstrip()} {marker}" if marker else raw)
        previous_end = end if previous_end is None else max(previous_end, end)
    return "\n".join(out)


def strip_markers(text: str) -> str:
    return re.sub(r"\s*🔊+", "", text or "")


def energy_peak_times(z: Sequence[float], max_peaks: int = 12, spacing: float = 4.0) -> List[float]:
    """The loudest moments, at least ``spacing`` seconds apart."""
    ranked = sorted(range(len(z)), key=lambda i: z[i], reverse=True)
    peaks: List[float] = []
    for second in ranked:
        if z[second] < PEAK_Z or len(peaks) >= max_peaks:
            break
        if all(abs(second - p) >= spacing for p in peaks):
            peaks.append(float(second))
    return sorted(peaks)


ENERGY_PROMPT_NOTE = (
    "🔊 at the end of a transcript line marks a volume peak well above this video's "
    "average: shouting, celebrating, a scare, a loud in-game moment. 🔊🔊 is a very strong "
    "peak. In live streams and gameplay these are usually the best moments: prefer "
    "segments that contain one, and put the peak in the first seconds (the hook) when the "
    "story allows. Lines in parentheses are stretches with no speech; never use their "
    "times as start_time or end_time."
)
