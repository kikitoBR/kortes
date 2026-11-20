"""Tape-rewind beat between the cold-open teaser and the clip ("Ganho inicial").

Inspired by SHARINGAN's flash-forward transition (src/cortes/render.ts, MIT
licence, (c) 2026 the SHARINGAN authors): the end of the teaser plays
backwards at 3x with tape noise, washed-out colour and a caption, then the
clip starts from the beginning.

The beat paints over a placeholder range of the same length that was already
rendered (see ``timeline.hook_rewind_point``), so the clip keeps its duration
and every caption/source-map timestamp stays valid.
"""

import os
import tempfile
from pathlib import Path

from .common import FONTS_DIR, HOOK_REWIND_SECONDS, logger
from .ffmpeg import (
    build_audio_output_args,
    build_final_video_encode_args,
    ffmpeg_escape_filter_path,
    ffprobe_has_audio,
    output_fps_for,
    run_ffmpeg_command,
)

REWIND_SPEED = 3
REWIND_LABEL = "MOMENTOS ANTES..."
REWIND_FONT = "Anton-Regular.ttf"


def build_rewind_filter(
    at: float,
    fps: int,
    has_audio: bool,
    font_path: Path,
    label_path: Path,
    rewind_seconds: float = HOOK_REWIND_SECONDS,
) -> str:
    """filter_complex replacing [at, at+rewind] with the reversed teaser end."""
    source = rewind_seconds * REWIND_SPEED
    font = ffmpeg_escape_filter_path(font_path)
    label = ffmpeg_escape_filter_path(label_path)
    norm = f"fps={fps},format=yuv420p,setsar=1"
    graph = [
        "[0:v]split=3[va][vb][vc]",
        f"[va]trim=end={at:.3f},setpts=PTS-STARTPTS,{norm}[pre]",
        (
            f"[vb]trim=start={at - source:.3f}:end={at:.3f},setpts=PTS-STARTPTS,reverse,"
            f"setpts=PTS/{REWIND_SPEED},{norm},"
            "noise=alls=38:allf=t,eq=saturation=0.3:contrast=1.2:brightness=-0.03,"
            "rgbashift=rh=-10:bh=10,"
            f"drawtext=fontfile={font}:text='REW <<':fontcolor=white:fontsize=h*0.038:"
            "borderw=4:bordercolor=black:x=w*0.07:y=h*0.07,"
            f"drawtext=fontfile={font}:textfile={label}:fontcolor=white:fontsize=h*0.055:"
            "borderw=8:bordercolor=black:x=(w-tw)/2:y=h*0.45[rw]"
        ),
        f"[vc]trim=start={at + rewind_seconds:.3f},setpts=PTS-STARTPTS,{norm}[post]",
        "[pre][rw][post]concat=n=3:v=1:a=0[v]",
    ]
    if has_audio:
        graph += [
            "[0:a]asplit=3[aa][ab][ac]",
            f"[aa]atrim=end={at:.3f},asetpts=PTS-STARTPTS[apre]",
            (
                f"[ab]atrim=start={at - source:.3f}:end={at:.3f},asetpts=PTS-STARTPTS,"
                "areverse,atempo=2,atempo=1.5,volume=0.7[arw]"
            ),
            f"[ac]atrim=start={at + rewind_seconds:.3f},asetpts=PTS-STARTPTS[apost]",
            "[apre][arw][apost]concat=n=3:v=0:a=1[a]",
        ]
    return ";".join(graph)


def apply_hook_rewind(
    clip_path: Path,
    at: float,
    label: str = REWIND_LABEL,
    rewind_seconds: float = HOOK_REWIND_SECONDS,
) -> bool:
    """Paint the rewind beat over ``clip_path`` in place. False leaves it untouched."""
    font_path = FONTS_DIR / REWIND_FONT
    if not font_path.exists():
        logger.warning("Rewind font %s missing; keeping the hard cut", font_path)
        return False
    fps = output_fps_for(clip_path)
    has_audio = ffprobe_has_audio(clip_path)
    with tempfile.TemporaryDirectory(prefix="kortes_rewind_") as work:
        label_path = Path(work) / "label.txt"
        label_path.write_text(label, encoding="utf-8")
        out_path = Path(work) / "rewound.mp4"
        command = [
            "ffmpeg", "-y", "-i", str(clip_path),
            "-filter_complex",
            build_rewind_filter(at, fps, has_audio, font_path, label_path, rewind_seconds),
            "-map", "[v]",
            *(["-map", "[a]"] if has_audio else []),
            *build_final_video_encode_args(fps=fps),
            *build_audio_output_args(has_audio, loudnorm=False),
            "-movflags", "+faststart",
            str(out_path),
        ]
        if run_ffmpeg_command(command).returncode != 0 or not out_path.exists():
            logger.warning("Rewind beat render failed; keeping the hard cut")
            return False
        os.replace(out_path, clip_path)
    logger.info("Added %.1fs rewind beat at %.2fs", rewind_seconds, at)
    return True
