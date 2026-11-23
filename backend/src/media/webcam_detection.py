"""Find a streamer's webcam overlay inside a gameplay video.

Ported from SHARINGAN's live-cut camera finder (src/cortes/camera.ts, MIT
licence, (c) 2026 the SHARINGAN authors). The idea:

1. Sample ~24 frames spread over the clip and detect every face. The face that
   shows up in (almost) the same place in many frames is the streamer's;
   faces of game characters move around and never form a steady group.
2. Around that face, the webcam's border is a straight line that stays put in
   every frame while game edges keep moving. For each column (and row) near
   the face, measure the edge strength per frame and keep the MEDIAN across
   frames, so only an edge present in most of the clip survives. The strongest
   such line on each side is the webcam border.
3. A side without a clear border falls back to a box proportional to the face
   (head and shoulders), or to the frame edge when the webcam touches it.
"""

from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from .common import logger
from .face_detection import open_haar_cascade, open_yunet_detector

Box = Tuple[float, float, float, float]  # (x, y, w, h)

SAMPLE_FRAMES = 24
ANALYSIS_WIDTH = 640
# A border must beat this mean grey-level jump (0-255) and 3x the median.
EDGE_MIN_STRENGTH = 12.0
EDGE_DOMINANCE = 3.0
# Motion-jump border: compare mean temporal std (grey levels) over this many
# pixels on each side; the outside must move at least this much more.
MOTION_WINDOW = 4
MOTION_JUMP_MIN = 8.0
# A nearer jump at least this share of the biggest one is the webcam border.
NEAREST_JUMP_SHARE = 0.5
# A face wider than this share of the frame means the whole video is the
# camera (a podcast/talking head), not a webcam overlay.
FULL_CAMERA_FACE_WIDTH = 0.2


def _median(values: Sequence[float]) -> float:
    return float(np.median(values)) if len(values) else 0.0


def group_fixed_face(
    faces_per_frame: Sequence[Sequence[Box]], width: float
) -> Optional[Tuple[Box, List[int]]]:
    """The face that appears in the same place across frames (median box).

    Returns ``(box, frame_indexes)`` for the group seen in the most frames, or
    None when no face is steady in at least max(3, 20%) of the frames.
    """
    groups: List[Dict] = []
    for index, faces in enumerate(faces_per_frame):
        for face in faces:
            x, y, w, h = face[:4]
            cx, cy = x + w / 2, y + h / 2
            for group in groups:
                ratio = w / max(group["w"], 1e-6)
                if (
                    np.hypot(group["cx"] - cx, group["cy"] - cy) < width * 0.06
                    and 0.6 < ratio < 1.6
                ):
                    group["boxes"].append((x, y, w, h))
                    group["frames"].add(index)
                    break
            else:
                groups.append(
                    {"cx": cx, "cy": cy, "w": w, "boxes": [(x, y, w, h)], "frames": {index}}
                )
    if not groups:
        return None
    best = max(groups, key=lambda g: len(g["frames"]))
    if len(best["frames"]) < max(3, len(faces_per_frame) * 0.2):
        return None
    boxes = best["boxes"]
    median_box = tuple(_median([b[i] for b in boxes]) for i in range(4))
    return median_box, sorted(best["frames"])  # type: ignore[return-value]


def box_around_face(face: Box, width: float, height: float) -> Box:
    """Default webcam box: face in the upper third, shoulders visible."""
    fx, fy, fw, fh = face
    w = min(width, fw * 3.6)
    h = min(height, fh * 3.1)
    x = min(max(0.0, fx + fw / 2 - w / 2), width - w)
    y = min(max(0.0, fy - fh * 0.9), height - h)
    return x, y, w, h


def webcam_edges(
    grays: np.ndarray, face: Box, base: Box
) -> Tuple[Box, int]:
    """Webcam borders from steady straight edges around the face.

    ``grays`` is (frames, h, w) float32 greyscale; ``face`` and ``base`` are in
    the same scale. Returns the box and how many of its 4 sides were seen.
    """
    _, h, w = grays.shape
    fx, fy, fw, fh = face

    def clip_range(lo: float, hi: float, size: int) -> np.ndarray:
        return np.arange(
            int(np.clip(round(lo), 0, size - 1)), int(np.clip(round(hi), 0, size - 1)) + 1
        )

    rows = clip_range(fy - 0.3 * fh, fy + 1.5 * fh, h)
    cols = clip_range(fx - 0.5 * fw, fx + 1.5 * fw, w)

    # Vertical edge strength per column x (1..w-2): mean over the face band,
    # then the median across frames.
    band = grays[:, rows, :]
    column_strength = np.zeros(w, dtype=np.float32)
    column_strength[1:-1] = np.median(
        np.abs(band[:, :, 2:] - band[:, :, :-2]).mean(axis=1), axis=0
    )
    strip = grays[:, :, cols]
    row_strength = np.zeros(h, dtype=np.float32)
    row_strength[1:-1] = np.median(
        np.abs(strip[:, 2:, :] - strip[:, :-2, :]).mean(axis=2), axis=0
    )

    # A line that runs across the whole frame (letterbox/pillarbox bars, a HUD
    # strip) is steady too, but it is not the webcam: the webcam's border only
    # spans the webcam. Drop candidates whose frame-wide strength is close to
    # the local one.
    full_columns = np.zeros(w, dtype=np.float32)
    full_columns[1:-1] = np.median(
        np.abs(grays[:, :, 2:] - grays[:, :, :-2]).mean(axis=1), axis=0
    )
    full_rows = np.zeros(h, dtype=np.float32)
    full_rows[1:-1] = np.median(
        np.abs(grays[:, 2:, :] - grays[:, :-2, :]).mean(axis=2), axis=0
    )
    column_strength = np.where(full_columns >= column_strength * 0.6, 0.0, column_strength)
    row_strength = np.where(full_rows >= row_strength * 0.6, 0.0, row_strength)

    # How much each pixel changes over the clip: the streamer's room barely
    # moves while the game changes all the time, so the webcam border is where
    # this jumps from low (inside) to high (outside). Unlike edges, it ignores
    # steady lines inside the webcam (shelves, door frames) and black bars.
    motion = grays.std(axis=0)
    column_motion = motion[rows, :].mean(axis=0)
    row_motion = motion[:, cols].mean(axis=1)

    sides_found = 0

    # How much the game moves: a still stretch next to a moving game is the room.
    scene_motion = float(np.median(motion))

    def side(
        start: float, stop: float, strength: np.ndarray, motion_profile: np.ndarray,
        default: float, border: float, room_to_edge: bool = False,
    ) -> float:
        nonlocal sides_found
        start_i, stop_i = int(round(start)), int(round(stop))
        step = -1 if start_i > stop_i else 1
        ks = list(range(start_i, stop_i + step, step))
        ks = [k for k in ks if 0 <= k < len(strength)]
        if not ks:
            return default

        # 1) The motion jump, walking outward from the face.
        size = len(motion_profile)

        def window(k: int, direction: int) -> float:
            idx = [k + direction * j for j in range(1, MOTION_WINDOW + 1)]
            idx = [i for i in idx if 0 <= i < size]
            return float(motion_profile[idx].mean()) if idx else float(motion_profile[k])

        jumps = np.array([window(k, step) - window(k, -step) for k in ks])
        if float(jumps.max()) > MOTION_JUMP_MIN:
            # The border is the first strong jump walking out from the face: a
            # farther, somewhat bigger one is the game itself (item names and
            # HUD text that come and go below a top-corner webcam).
            strong = max(MOTION_JUMP_MIN, float(jumps.max()) * NEAREST_JUMP_SHARE)
            i = next(n for n, jump in enumerate(jumps) if jump >= strong)
            while i + 1 < len(jumps) and jumps[i + 1] >= jumps[i]:
                i += 1  # up to that jump's peak
            k = ks[i]
            # Snap to the sharpest steady edge right next to the jump.
            near = [n for n in ks if abs(n - k) <= 2 and strength[n] > 0]
            sides_found += 1
            return float(max(near, key=lambda n: strength[n]) if near else k)

        # 2) A webcam against the side of the frame has no game beside it: when
        # the game moves but everything from the face to the frame edge is as
        # still as the room, the straight lines there are shelves and doors.
        if (
            room_to_edge
            and abs(ks[-1] - border) <= 2
            and scene_motion > MOTION_JUMP_MIN
            and float(np.median(motion_profile[ks])) < scene_motion * 0.5
        ):
            sides_found += 1
            return border

        # 3) No motion jump (static game scene): the steady straight edge.
        values = strength[ks]
        best = int(np.argmax(values))
        if values[best] > EDGE_MIN_STRENGTH and values[best] > _median(values) * EDGE_DOMINANCE:
            sides_found += 1
            return float(ks[best])
        # No clear border: when the default box overruns the frame, the webcam
        # sits against the frame edge.
        return border if abs(default - border) < abs(ks[-1] - border) + 2 else default

    bx, by, bw, bh = base
    left = side(fx - 0.3 * fw, max(1, fx - 6 * fw), column_strength, column_motion, bx, 0, True)
    right = side(
        fx + 1.3 * fw, min(w - 2, fx + 7 * fw), column_strength, column_motion, bx + bw, w, True
    )
    # The face usually sits right under the top of the webcam.
    top = side(fy - 0.05 * fh, max(1, fy - 4 * fh), row_strength, row_motion, by, 0)
    bottom = side(fy + 1.4 * fh, min(h - 2, fy + 6 * fh), row_strength, row_motion, by + bh, h)
    return (left, top, right - left, bottom - top), sides_found


def _sample_frames(clip_path: Path, count: int) -> List[np.ndarray]:
    capture = cv2.VideoCapture(str(clip_path))
    frames: List[np.ndarray] = []
    try:
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if total <= 0:
            return frames
        positions = sorted({int(total * (0.05 + 0.9 * i / max(1, count - 1))) for i in range(count)})
        for position in positions:
            capture.set(cv2.CAP_PROP_POS_FRAMES, min(position, total - 1))
            ok, frame = capture.read()
            if ok and frame is not None:
                frames.append(frame)
    finally:
        capture.release()
    return frames


def _detect_faces(frame_bgr: np.ndarray, yunet, haar) -> List[Box]:
    if yunet is not None:
        try:
            return [(x, y, w, h) for x, y, w, h, _ in yunet.detect(frame_bgr)]
        except Exception as exc:
            logger.debug("YuNet failed on a webcam frame: %s", exc)
    if haar is None:
        return []
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    side = max(12, int(frame_bgr.shape[1] * 0.012))
    return [tuple(map(float, f)) for f in haar.detectMultiScale(gray, 1.15, 4, minSize=(side, side))]


def detect_webcam_box(clip_path: Path) -> Optional[Dict[str, object]]:
    """Locate the streamer's webcam overlay in a landscape clip.

    Returns ``{"kind": "corner", "box": (x, y, w, h), "face": (x, y, w, h), "confidence": float}`` in
    source pixels, ``{"kind": "full"}`` when the whole frame is the camera, or
    None when no steady face was found.
    """
    frames = _sample_frames(clip_path, SAMPLE_FRAMES)
    if len(frames) < 3:
        return None
    height, width = frames[0].shape[:2]
    yunet, haar = open_yunet_detector(), open_haar_cascade()
    faces_per_frame = [_detect_faces(frame, yunet, haar) for frame in frames]
    fixed = group_fixed_face(faces_per_frame, width)
    if not fixed:
        return None
    face, seen_in = fixed
    presence = len(seen_in) / len(frames)
    if face[2] > width * FULL_CAMERA_FACE_WIDTH:
        return {"kind": "full", "confidence": presence}

    scale = min(1.0, ANALYSIS_WIDTH / float(width))
    small_size = (max(2, int(round(width * scale))), max(2, int(round(height * scale))))
    grays = np.stack(
        [
            cv2.cvtColor(
                cv2.resize(frame, small_size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY
            ).astype(np.float32)
            for frame in frames
        ]
    )
    base = box_around_face(face, width, height)
    scaled = lambda box, k: tuple(v * k for v in box)  # noqa: E731
    found, sides = webcam_edges(grays, scaled(face, scale), scaled(base, scale))
    small_w, small_h = small_size
    plausible = (
        found[2] > face[2] * scale * 1.4
        and found[3] > face[3] * scale * 1.4
        and found[2] < small_w * 0.7
        and found[3] < small_h * 0.8
    )
    box = scaled(found, 1 / scale) if plausible else base
    confidence = presence * (0.5 + sides / 8 if plausible else 0.4)
    logger.info(
        "Webcam %s at %s (face in %d/%d frames)",
        f"found with {sides}/4 borders" if plausible else "sized from the face",
        tuple(int(v) for v in box), len(seen_in), len(frames),
    )
    return {"kind": "corner", "box": box, "face": face, "confidence": round(confidence, 2)}


def find_steady_face(clip_path: Path) -> Optional[Box]:
    """The streamer's face (the one that stays put), in source pixels, or None.

    Used to centre a webcam box the user picked by hand on the face inside it.
    """
    frames = _sample_frames(clip_path, 12)
    if len(frames) < 3:
        return None
    yunet, haar = open_yunet_detector(), open_haar_cascade()
    fixed = group_fixed_face(
        [_detect_faces(frame, yunet, haar) for frame in frames], frames[0].shape[1]
    )
    return fixed[0] if fixed else None
