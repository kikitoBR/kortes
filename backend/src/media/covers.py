"""Cover (thumbnail) images for finished clips.

Layout follows SHARINGAN's covers (src/uploads/textos.ts, MIT licence, (c)
2026 the SHARINGAN authors): a frame of the clip, slightly punchier colour and
a vignette, with big Anton text in two balanced lines - the top one white with
a black outline, the bottom one on a red band. On vertical clips the text sits
a bit above the middle, clear of burned captions and the platform buttons.
"""

import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .common import FONTS_DIR, logger
from .face_detection import open_yunet_detector
from .ffmpeg import ffmpeg_escape_filter_path, ffprobe_duration, ffprobe_video_size, run_ffmpeg_command

COVER_FONT = "Anton-Regular.ttf"
COVER_BAND_COLOR = "0xEB1D20"
COVER_MAX_TEXT = 60
# The AI hook title is burned into the first ~4 s; covers skip that stretch so
# the frame never carries a second, smaller copy of the text.
COVER_SKIP_SECONDS = 4.5
COVER_CANDIDATES = 8


def balance_cover_lines(text: str) -> List[str]:
    """Upper-case text split into at most two lines of similar length."""
    words = " ".join(text.split()).upper()[:COVER_MAX_TEXT].split(" ")
    words = [w for w in words if w]
    if not words:
        return []
    if len(words) < 3 and len(" ".join(words)) <= 14:
        return [" ".join(words)]
    best, best_diff = 1, float("inf")
    for i in range(1, len(words)):
        diff = abs(len(" ".join(words[:i])) - len(" ".join(words[i:])))
        if diff < best_diff:
            best, best_diff = i, diff
    return [" ".join(words[:best]), " ".join(words[best:])]


def cover_size(width: int, height: int) -> Tuple[int, int]:
    """Cover in the clip's shape: portrait 1080x1920, square-ish 1080 wide, else 1280x720."""
    if height > width * 1.5:
        return 1080, 1920
    if height >= width * 0.9:
        return 1080, max(2, round(1080 * height / width / 2) * 2)
    return 1280, 720


def _frame_score(frame: np.ndarray, detector) -> float:
    """Sharp, well-lit frames with a big face make the best covers."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    sharpness = float(np.log1p(cv2.Laplacian(gray, cv2.CV_64F).var()))
    brightness = float(gray.mean())
    score = sharpness
    if brightness < 40 or brightness > 225:
        score -= 2.0
    if detector is not None:
        try:
            faces = detector.detect(frame)
        except Exception:
            faces = []
        if faces:
            area = max(w * h for _, _, w, h, _ in faces) / float(frame.shape[0] * frame.shape[1])
            score += 2.0 * min(1.0, area * 12)
    return score


def pick_cover_time(clip_path: Path, duration: Optional[float] = None) -> float:
    """Second of the clip whose frame scores best as a cover."""
    duration = duration if duration is not None else ffprobe_duration(clip_path)
    start = min(max(COVER_SKIP_SECONDS, duration * 0.12), duration * 0.6)
    end = duration * 0.92
    if end <= start:
        return round(duration * 0.35, 2)
    times = [start + (end - start) * i / (COVER_CANDIDATES - 1) for i in range(COVER_CANDIDATES)]
    detector = open_yunet_detector()
    capture = cv2.VideoCapture(str(clip_path))
    best_time, best_score = times[len(times) // 2], float("-inf")
    try:
        for t in times:
            capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            score = _frame_score(frame, detector)
            if score > best_score:
                best_time, best_score = t, score
    finally:
        capture.release()
    return round(best_time, 2)


def render_clip_cover(
    clip_path: Path, output_path: Path, text: str, at: Optional[float] = None
) -> float:
    """Write the cover JPEG and return the clip second it was taken from."""
    font_path = FONTS_DIR / COVER_FONT
    if not font_path.exists():
        raise RuntimeError(f"Fonte da capa ausente: {font_path}")
    width, height = ffprobe_video_size(clip_path)
    duration = ffprobe_duration(clip_path)
    out_w, out_h = cover_size(width, height)
    portrait = out_h > out_w
    if at is None:
        at = pick_cover_time(clip_path, duration)
    at = min(max(0.0, float(at)), max(0.0, duration - 0.1))

    lines = balance_cover_lines(text)
    with tempfile.TemporaryDirectory(prefix="kortes_cover_") as work:
        filters = [
            f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase",
            f"crop={out_w}:{out_h}",
            "eq=saturation=1.2:contrast=1.08",
            "vignette=PI/4",
        ]
        if lines:
            longest = max(len(line) for line in lines)
            size = round(min(120 if portrait else 112, (out_w * 0.9) / (max(longest, 1) * 0.5)))
            font = ffmpeg_escape_filter_path(font_path)
            # Portrait: near the gameplay/webcam divide (~40%), above burned
            # captions (~75%) and far from the platform's bottom bar.
            band_y = "h*0.42" if portrait else "h-160"
            top_y = f"h*0.42-{round(size * 1.35)}" if portrait else "h-300"
            files = []
            for index, line in enumerate(lines):
                path = Path(work) / f"line{index}.txt"
                path.write_text(line, encoding="utf-8")
                files.append(ffmpeg_escape_filter_path(path))
            if len(files) == 2:
                filters.append(
                    f"drawtext=fontfile={font}:textfile={files[0]}:fontsize={size}:fontcolor=white:"
                    f"borderw=7:bordercolor=black:x=(w-text_w)/2:y={top_y}"
                )
            filters.append(
                f"drawtext=fontfile={font}:textfile={files[-1]}:fontsize={size}:fontcolor=white:"
                f"box=1:boxcolor={COVER_BAND_COLOR}:boxborderw=16:x=(w-text_w)/2:y={band_y}"
            )
        command = [
            "ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(clip_path),
            "-frames:v", "1", "-vf", ",".join(filters), "-q:v", "2", str(output_path),
        ]
        if run_ffmpeg_command(command, timeout=120).returncode != 0 or not output_path.exists():
            raise RuntimeError("Não foi possível gerar a capa")
    logger.info("Cover rendered at %.2fs (%dx%d)", at, out_w, out_h)
    return at
