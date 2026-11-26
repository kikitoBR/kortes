"""The hook title's band styles and positions, and the cover's options."""

import re
import shutil
import subprocess

import pytest

from src.caption_templates import get_template
from src.media.captions import build_hook_title_ass, split_title_lines
from src.media.title_styles import DEFAULT_TITLE_STYLE, normalize_title_style, title_center


def test_style_keeps_only_valid_choices():
    assert normalize_title_style(None) == DEFAULT_TITLE_STYLE
    style = normalize_title_style({"preset": "faixa", "position": "lower", "color": "#00ff00", "size": "l", "duration": "always"})
    assert style == {"preset": "faixa", "position": "lower", "color": "#00FF00", "size": "l", "duration": "always"}
    assert normalize_title_style({"preset": "neon", "color": "red", "position": "side"}) == DEFAULT_TITLE_STYLE


def test_auto_sits_on_the_webcam_line():
    auto = normalize_title_style({})
    assert title_center(auto, "vertical_gameplay") == 0.40
    assert title_center(auto, "vertical_gameplay_bottom") == 0.60
    assert title_center(auto, "vertical") == 0.11
    assert title_center(normalize_title_style({"position": "bottom"}), "vertical_gameplay") == 0.84


def test_title_lines_stay_even_and_never_pass_three():
    words = "Jason quer mostrar profissionalismo sem matar ninguém".split()
    assert split_title_lines(words, 40) == ["Jason quer mostrar", "profissionalismo sem matar ninguém"]
    assert len(split_title_lines(words, 8)) == 3
    assert split_title_lines(["curto"], 10) == ["curto"]


def _events(preset, position="auto", duration="start", output_format="vertical_gameplay"):
    styles, events = build_hook_title_ass(
        "Jason quer mostrar profissionalismo sem matar ninguém", get_template("default"), 1080, 1920, 20.0,
        "Poppins ExtraBold", 64, None,
        style={"preset": preset, "position": position, "color": "#E11D2E", "duration": duration},
        output_format=output_format,
    )
    return styles, events


def test_two_colour_band_puts_the_last_line_on_the_accent():
    styles, events = _events("duas_cores")
    assert "Style: HookBox" in styles and len(events) >= 2
    assert all(",HookBox," in e for e in events)
    # White band, black text above; accent band (E11D2E -> &H..2E1DE1) on the last line.
    assert r"\3c&H00FFFFFF&" in events[0] and r"\c&H00000000&" in events[0]
    assert r"\3c&H002E1DE1&" in events[-1]
    ys = [int(re.search(r"\\pos\(540,(\d+)\)", e).group(1)) for e in events]
    assert ys == sorted(ys)
    middle = (ys[0] + ys[-1]) / 2
    assert abs(middle - 0.40 * 1920) < 2  # centred on the webcam/game line


def test_outline_styles_and_staying_the_whole_clip():
    _styles, events = _events("classico", position="top", duration="always")
    assert all(",Hook," in e for e in events)
    assert all(e.split(",")[2] == "0:00:19.95" for e in events)
    _styles, short = _events("faixa")
    assert r"\3a&H38&" in short[0]  # the dark band lets a little video through


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_cover_renders_every_style_font_and_look(tmp_path):
    from src.media.covers import COVER_FONTS, COVER_LOOKS, render_clip_cover

    clip = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=540x960:rate=5:duration=6",
                    "-pix_fmt", "yuv420p", str(clip)], check=True)
    for index, (font, look) in enumerate(zip(COVER_FONTS, list(COVER_LOOKS) * 2)):
        preset = ["duas_cores", "faixa", "faixa_cor", "classico", "destaque"][index % 5]
        out = tmp_path / f"cover-{font}.jpg"
        render_clip_cover(clip, out, "ele não esperava essa reação", 5.0, {"preset": preset, "position": "middle"}, font, look)
        assert out.stat().st_size > 10_000
