from pathlib import Path
from unittest.mock import patch

from src.media import reframing


def _faces(x, y, size, n=6):
    return [(x, y, size * size, 0.9) for _ in range(n)]


def test_gameplay_regions_frame_facecam_in_corner():
    regions = reframing.compute_gameplay_regions(1920, 1080, _faces(1700, 880, 120))

    assert regions is not None
    cam, game = regions["cam"], regions["game"]
    # Facecam keeps the top tile's aspect and contains the face.
    assert abs(cam["w"] / cam["h"] - 1080 / reframing.GAMEPLAY_CAM_H) < 0.02
    assert cam["x"] <= 1700 <= cam["x"] + cam["w"]
    assert cam["y"] <= 880 <= cam["y"] + cam["h"]
    assert cam["x"] + cam["w"] <= 1920 and cam["y"] + cam["h"] <= 1080
    # Game crop is a full-height centre cut with the bottom tile's aspect.
    assert game["h"] == 1080
    assert abs(game["w"] / game["h"] - 1080 / reframing.GAMEPLAY_GAME_H) < 0.01
    assert game["x"] == (1920 - game["w"]) // 2 // 2 * 2
    assert all(v % 2 == 0 for r in (cam, game) for v in r.values())


def test_gameplay_regions_need_a_face_and_landscape_source():
    assert reframing.compute_gameplay_regions(1920, 1080, []) is None
    assert reframing.compute_gameplay_regions(1080, 1920, _faces(540, 500, 200)) is None


def test_manual_webcam_box_is_cover_fitted_to_top_tile():
    # A 16:9 facecam in the bottom-right corner of a 1920x1080 frame.
    box = {"x": 0.75, "y": 0.75, "w": 0.25, "h": 0.25}
    regions = reframing.gameplay_regions_from_box(1920, 1080, box)

    cam = regions["cam"]
    assert abs(cam["w"] / cam["h"] - 1080 / reframing.GAMEPLAY_CAM_H) < 0.02
    # Cover fit stays inside the picked box (no game pixels pulled in).
    assert cam["x"] >= 1440 - 1 and cam["x"] + cam["w"] <= 1920
    assert cam["y"] >= 810 - 1 and cam["y"] + cam["h"] <= 1080
    assert 266 <= cam["h"] <= 270  # fills the box height (even-rounded)


def test_manual_webcam_box_skips_face_detection():
    box = {"x": 0.0, "y": 0.0, "w": 0.3, "h": 0.3}
    with (
        patch.object(reframing, "ffprobe_video_size", return_value=(1920, 1080)),
        patch.object(reframing, "detect_faces_in_clip") as detect,
        patch.object(reframing, "detect_letterbox_rows", return_value=None),
    ):
        regions = reframing.detect_gameplay_plan(Path("in.mp4"), box)

    detect.assert_not_called()
    cam = regions["cam"]
    # 576x324 box, cover-fitted and centred inside it.
    assert cam["y"] == 0 and 0 < cam["x"] and cam["x"] + cam["w"] <= 576


def test_letterbox_rows_parsed_from_cropdetect():
    log = "[Parsed_cropdetect_1] x1:0 x2:1279 y1:40 y2:679 crop=1280:640:0:40\n"
    assert reframing.parse_letterbox_rows(log, 1280, 720) == (40, 640)
    # Full frame, pillarbox or a dark scene shrinking the box are ignored.
    assert reframing.parse_letterbox_rows("crop=1280:720:0:0", 1280, 720) is None
    assert reframing.parse_letterbox_rows("crop=960:720:160:0", 1280, 720) is None
    assert reframing.parse_letterbox_rows("crop=1280:300:0:200", 1280, 720) is None


def test_game_crop_stays_inside_letterbox():
    game = reframing._gameplay_game_crop(1280, 720, (40, 640))
    assert game["y"] >= 40 and game["y"] + game["h"] <= 680
    assert abs(game["w"] / game["h"] - 1080 / reframing.GAMEPLAY_GAME_H) < 0.01


def test_normalize_webcam_region_rejects_bad_input():
    from src.media.common import normalize_webcam_region

    assert normalize_webcam_region(None) is None
    assert normalize_webcam_region({"x": "a", "y": 0, "w": 0.2, "h": 0.2}) is None
    assert normalize_webcam_region({"x": 0.1, "y": 0.1, "w": 0.01, "h": 0.2}) is None
    assert normalize_webcam_region({"x": 0.9, "y": -1, "w": 0.5, "h": 0.3}) == {
        "x": 0.9, "y": 0.0, "w": 0.1, "h": 0.3,
    }


def test_gameplay_render_stacks_cam_over_game():
    commands = []

    class _Result:
        returncode = 0

    def fake_run(cmd, *args, **kwargs):
        commands.append(cmd)
        return _Result()

    regions = reframing.compute_gameplay_regions(1920, 1080, _faces(300, 250, 110))
    with (
        patch.object(reframing, "ffprobe_video_size", return_value=(1920, 1080)),
        patch.object(reframing, "ffprobe_has_audio", return_value=True),
        patch.object(reframing, "output_fps_for", return_value=30),
        patch.object(reframing, "detect_gameplay_plan", return_value=regions),
        patch.object(reframing, "run_ffmpeg_command", side_effect=fake_run),
    ):
        ok, w, h = reframing.render_reframed_clip_ffmpeg(
            Path("in.mp4"), Path("out.mp4"), "vertical_gameplay"
        )

    assert (ok, w, h) == (True, 1080, 1920)
    graph = commands[0][commands[0].index("-filter_complex") + 1]
    assert f"scale=1080:{reframing.GAMEPLAY_CAM_H}" in graph
    assert f"scale=1080:{reframing.GAMEPLAY_GAME_H}" in graph
    assert "[cv][gv]vstack" in graph
