"""Kortes Desktop free plan: the Kortes logo and name, translucent, moving around.

One extra ffmpeg pass over a finished clip. The mark hops between four spots
every few seconds, away from the hook title (top) and the captions (about 75%
down), so it cannot be cropped out of one corner.
"""

import logging
import shutil
from pathlib import Path

from .ffmpeg import build_final_video_encode_args, ffprobe_video_size, run_ffmpeg_command

logger = logging.getLogger(__name__)

WATERMARK_PNG = Path(__file__).with_name("assets") / "watermark.png"
WATERMARK_OPACITY = 0.55
WATERMARK_WIDTH = 0.30  # share of the video's width
HOP_SECONDS = 4.0
# (x, y) as shares of the free space (video size minus the mark), one per hop.
SPOTS = [(0.06, 0.20), (0.94, 0.42), (0.06, 0.58), (0.94, 0.94)]


def _position_expr(axis: int) -> str:
    """ffmpeg expression that picks the spot for the current hop."""
    size = "(main_w-overlay_w)" if axis == 0 else "(main_h-overlay_h)"
    count = len(SPOTS)
    expr = f"{SPOTS[-1][axis]}*{size}"
    for index in range(count - 2, -1, -1):
        expr = f"if(lt(mod(t,{HOP_SECONDS * count}),{HOP_SECONDS * (index + 1)}),{SPOTS[index][axis]}*{size},{expr})"
    # commas inside the expression must be escaped for the filter graph
    return expr.replace(",", "\\,")


def watermark_filter(video_width: int) -> str:
    mark = max(120, int(video_width * WATERMARK_WIDTH)) // 2 * 2
    return (
        f"[1:v]format=rgba,scale={mark}:-1,colorchannelmixer=aa={WATERMARK_OPACITY}[wm];"
        f"[0:v][wm]overlay=x={_position_expr(0)}:y={_position_expr(1)}:format=auto[v]"
    )


def apply_watermark(clip_path: Path) -> bool:
    """Burn the mark into ``clip_path`` in place. False (clip untouched) on failure."""
    clip_path = Path(clip_path)
    if not WATERMARK_PNG.exists():
        logger.error("Watermark image missing: %s", WATERMARK_PNG)
        return False
    width, _height = ffprobe_video_size(clip_path)
    tmp = clip_path.with_name(f"{clip_path.stem}.wm{clip_path.suffix}")
    command = [
        "ffmpeg", "-y", "-hide_banner", "-nostdin",
        "-i", str(clip_path), "-loop", "1", "-i", str(WATERMARK_PNG),
        "-filter_complex", watermark_filter(width),
        "-map", "[v]", "-map", "0:a?", "-shortest",
        *build_final_video_encode_args(),
        "-c:a", "copy", "-movflags", "+faststart",
        str(tmp),
    ]
    result = run_ffmpeg_command(command, timeout=900)
    if result.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return False
    shutil.move(str(tmp), str(clip_path))
    return True
