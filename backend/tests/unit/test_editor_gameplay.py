import shutil
import subprocess
from unittest.mock import patch

import numpy as np
import pytest
from pydantic import ValidationError

from src.editor_document import (
    EditDocument,
    Framing,
    game_cut,
    output_size,
    render_document,
    webcam_cut,
)

WEBCAM = {"x": 0.0, "y": 220 / 360, "w": 120 / 640, "h": 100 / 360}


def gameplay_document(**framing):
    return EditDocument.model_validate(
        {
            "segments": [{"id": "a", "start": 0, "end": 1}],
            "captions": {"enabled": False},
            "framing": {"layout": "gameplay", "webcam": WEBCAM, **framing},
        }
    )


def test_gameplay_layout_needs_a_webcam_inside_the_frame():
    with pytest.raises(ValidationError):
        Framing.model_validate({"layout": "gameplay"})
    with pytest.raises(ValidationError):
        Framing.model_validate(
            {"layout": "gameplay", "webcam": {"x": 0.9, "y": 0, "w": 0.3, "h": 0.2}}
        )
    # Drafts saved before the layout existed stay valid.
    assert Framing.model_validate({"aspect": "square"}).layout == "single"


def test_gameplay_always_renders_vertical():
    doc = gameplay_document(aspect="original")
    assert output_size(doc, 1920, 1080) == (1080, 1920)


def test_cuts_match_the_tiles():
    framing = gameplay_document().framing
    x, y, w, h = webcam_cut(framing.webcam, 640, 360, 1080 / 768)
    assert w / h == pytest.approx(1080 / 768)
    assert x == 0 and 220 <= y and y + h <= 320  # inside the marked box
    gx, gy, gw, gh = game_cut(framing, 640, 360, 1080 / 1152)
    assert gh == pytest.approx(360) and gx == pytest.approx((640 - gw) / 2)
    assert game_cut(framing.model_copy(update={"x": 1}), 640, 360, 1080 / 1152)[0] == pytest.approx(640 - gw)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_real_render_stacks_the_webcam_over_the_game(tmp_path):
    # Blue "game" with a red "webcam" in the bottom-left corner.
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
            "-i", "color=c=blue:size=640x360:rate=24:duration=1",
            "-vf", "drawbox=x=0:y=220:w=120:h=100:color=red:t=fill",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(tmp_path / "clean.mp4"),
        ],
        check=True,
        capture_output=True,
    )
    # Plain runner: the geometry is under test here, not progress polling.
    def run(command, directory, job_id, duration):
        subprocess.run(command, check=True, capture_output=True)

    with patch("src.editor_document.run_render", run):
        render_document(tmp_path, "c" * 32, gameplay_document(), "tiktok")
    frame = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-ss", "0.5", "-i", str(tmp_path / f"export-{'c' * 32}.mp4"),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    pixels = np.frombuffer(frame, dtype=np.uint8).reshape(1920, 1080, 3).astype(int)
    cam, game = pixels[40:728].mean(axis=(0, 1)), pixels[808:].mean(axis=(0, 1))
    assert cam[0] > 180 and cam[2] < 80  # webcam tile is the red box
    assert game[2] > 180 and game[0] < 80  # game tile is the blue centre cut


def test_editor_framing_follows_the_clip_render():
    from src.services.editor_service import gameplay_framing

    regions = {
        "cam": {"x": 0, "y": 600, "w": 480, "h": 340},
        "game": {"x": 456, "y": 60, "w": 900, "h": 960},  # letterboxed source
    }
    with patch("src.media.reframing.detect_gameplay_plan", return_value=regions), patch(
        "src.media.ffmpeg.ffprobe_video_size", return_value=(1920, 1080)
    ):
        framing = gameplay_framing("clip.mp4")
    Framing.model_validate(framing)
    assert framing["webcam"] == {"x": 0.0, "y": 0.5556, "w": 0.25, "h": 0.3148}
    assert framing["zoom"] == pytest.approx(1080 / 960, abs=1e-3)
    assert framing["x"] == pytest.approx(456 / 1020, abs=1e-3)
    assert framing["y"] == pytest.approx(0.5)

    with patch("src.media.reframing.detect_gameplay_plan", return_value=None):
        assert gameplay_framing("clip.mp4") is None
