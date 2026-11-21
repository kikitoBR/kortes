"""The ready-made layouts render on real frames, in clips and in the editor."""

import shutil
import subprocess
from unittest.mock import patch

import numpy as np
import pytest

from src.editor_document import EditDocument, render_document
from src.media.common import VALID_OUTPUT_FORMATS, WEBCAM_OUTPUT_FORMATS

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")

# Blue game with a red webcam in the bottom-left corner (640x360).
WEBCAM = {"x": 0.0, "y": 220 / 360, "w": 120 / 640, "h": 100 / 360}


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    path = tmp_path_factory.mktemp("layouts") / "game.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=24:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
         "-vf", "drawbox=x=0:y=220:w=120:h=100:color=red:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(path)],
        check=True, capture_output=True,
    )
    return path


def frame(path, at=0.5, size=(1080, 1920)):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(size[1], size[0], 3).astype(int)


def red(area):
    mean = area.mean(axis=(0, 1))
    return mean[0] > 170 and mean[2] < 90


def blue(area):
    mean = area.mean(axis=(0, 1))
    return mean[2] > 170 and mean[0] < 90


def test_new_layouts_are_known():
    assert {"vertical_gameplay_bottom", "vertical_cam_float", "vertical_blur"} <= VALID_OUTPUT_FORMATS
    assert "vertical_blur" not in WEBCAM_OUTPUT_FORMATS


@pytest.mark.parametrize("layout", ["vertical_gameplay", "vertical_gameplay_bottom", "vertical_cam_float", "vertical_blur"])
def test_clip_layouts_put_the_webcam_where_they_say(tmp_path, source, layout):
    from src.media.reframing import render_reframed_clip_ffmpeg

    out = tmp_path / "out.mp4"
    with patch("src.media.reframing.detect_letterbox_rows", return_value=None):
        ok, width, height = render_reframed_clip_ffmpeg(source, out, layout, webcam_region=WEBCAM)
    assert ok and (width, height) == (1080, 1920)
    pixels = frame(out)
    if layout == "vertical_gameplay":
        assert red(pixels[40:700]) and blue(pixels[820:1880])
    elif layout == "vertical_gameplay_bottom":
        assert blue(pixels[40:1100]) and red(pixels[1220:1880])
    elif layout == "vertical_cam_float":
        assert red(pixels[320:600, 60:500])  # the floating webcam, top-left
        assert blue(pixels[900:1800, 100:1000])  # the game fills the rest
        assert pixels[296, 300].min() > 200  # its white border
    else:
        middle = pixels[960 - 150:960 + 150, 300:800]
        assert blue(middle)  # the whole picture in the middle
        # Above it, the blurred and darkened copy of the same picture.
        assert pixels[200:500, 300:800].mean(axis=(0, 1))[2] < middle.mean(axis=(0, 1))[2]


def document(**framing):
    return EditDocument.model_validate(
        {"segments": [{"id": "a", "start": 0, "end": 1}], "captions": {"enabled": False}, "framing": framing}
    )


@pytest.mark.parametrize(
    "framing, check",
    [
        ({"layout": "gameplay", "webcam": WEBCAM, "camPosition": "bottom"}, lambda p: blue(p[40:1100]) and red(p[1220:1880])),
        ({"layout": "float", "webcam": WEBCAM}, lambda p: red(p[320:600, 60:500]) and blue(p[900:1800, 100:1000])),
        ({"fit": "contain", "background": "blur"}, lambda p: blue(p[860:1060, 300:800])),
    ],
)
def test_editor_exports_the_same_layouts(tmp_path, source, framing, check):
    shutil.copy(source, tmp_path / "clean.mp4")

    def run(command, directory, job_id, duration):
        subprocess.run(command, check=True, capture_output=True)

    with patch("src.editor_document.run_render", run):
        render_document(tmp_path, "d" * 32, document(**framing), "tiktok")
    assert check(frame(tmp_path / f"export-{'d' * 32}.mp4"))


def test_editor_float_layout_needs_a_webcam():
    with pytest.raises(Exception):
        document(layout="float")
