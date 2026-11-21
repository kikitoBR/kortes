import shutil
import subprocess

import pytest

from src.media.ffmpeg import loudnorm_filter_for, measure_loudness

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")


def make_clip(path, volume: float):
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6",
            "-f", "lavfi", "-i", f"aevalsrc='{volume}*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*0.5*t))':s=48000:d=6",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_two_pass_filter_uses_the_measurement(tmp_path):
    clip = tmp_path / "quiet.mp4"
    make_clip(clip, 0.02)
    measured = measure_loudness(clip)
    assert measured and measured["input_i"] < -30
    assert "linear=true" in loudnorm_filter_for(clip)


@pytest.mark.parametrize("volume", [0.02, 0.9])
def test_clips_land_on_minus_14_lufs(tmp_path, volume):
    from src.media.reframing import render_reframed_clip_ffmpeg

    clip = tmp_path / "source.mp4"
    out = tmp_path / "out.mp4"
    make_clip(clip, volume)
    ok, _, _ = render_reframed_clip_ffmpeg(clip, out, "original")
    assert ok
    measured = measure_loudness(out)
    assert measured["input_i"] == pytest.approx(-14, abs=1.0)
    # "original" without captions copies the picture untouched.
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_frames", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert probe.startswith("h264")
