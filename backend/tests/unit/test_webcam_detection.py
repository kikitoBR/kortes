import numpy as np

from src.media import webcam_detection as wd


def _stream_frames(n=24, seed=3):
    """Letterboxed 'gameplay' frames with a fixed webcam overlay.

    Game pixels change every frame; the webcam (x 400-560, y 120-230 on a
    640x360 frame) holds a static room with a steady shelf edge inside it.
    """
    rng = np.random.default_rng(seed)
    h, w = 360, 640
    room = np.full((110, 160), 70.0, dtype=np.float32)
    room[:, 60:] = 150.0  # a bright shelf: a strong steady edge INSIDE the webcam
    frames = []
    for _ in range(n):
        game = rng.uniform(0, 255, size=(h, w)).astype(np.float32)
        game = (game + np.roll(game, 1, axis=1) + np.roll(game, 1, axis=0)) / 3  # some texture
        game[:20] = 0
        game[340:] = 0  # letterbox bars: steady full-width lines
        game[120:230, 400:560] = room
        frames.append(game)
    return np.stack(frames)


def test_group_fixed_face_prefers_the_steady_face():
    streamer = (450.0, 140.0, 40.0, 40.0)
    frames = []
    for i in range(10):
        moving_character = (50.0 + i * 40, 200.0, 38.0, 38.0)
        frames.append([streamer, moving_character])
    box, seen = wd.group_fixed_face(frames, 640)
    assert box == streamer
    assert len(seen) == 10


def test_group_fixed_face_needs_enough_frames():
    frames = [[(450.0, 140.0, 40.0, 40.0)]] + [[] for _ in range(20)]
    assert wd.group_fixed_face(frames, 640) is None


def test_webcam_edges_find_the_overlay_not_bars_or_shelves():
    grays = _stream_frames()
    face = (455.0, 135.0, 36.0, 36.0)
    base = wd.box_around_face(face, 640, 360)
    (x, y, w, h), sides = wd.webcam_edges(grays, face, base)
    assert sides >= 3
    assert abs(x - 400) <= 2
    assert abs((x + w) - 560) <= 2
    assert abs(y - 120) <= 2  # not the letterbox edge at y=20
    assert abs((y + h) - 230) <= 2


def test_webcam_bottom_is_the_nearest_jump_not_the_hud_below():
    # Under the webcam the game is calm; farther down an item name flashes
    # (a bigger motion jump). The webcam still ends where the game starts.
    grays = _stream_frames()
    rng = np.random.default_rng(7)
    for frame in grays:
        calm = rng.uniform(0, 180, size=(70, 640)).astype(np.float32)
        frame[230:300] = (calm + np.roll(calm, 1, axis=1) + np.roll(calm, 1, axis=0)) / 3
        frame[300:315] = 30.0
        flash = rng.uniform(0, 255, size=(25, 640)).astype(np.float32)
        frame[315:340] = (flash + np.roll(flash, 1, axis=1) + np.roll(flash, 1, axis=0)) / 3
    face = (455.0, 135.0, 36.0, 36.0)
    (x, y, w, h), _ = wd.webcam_edges(grays, face, wd.box_around_face(face, 640, 360))
    assert abs((y + h) - 230) <= 2
    assert abs(y - 120) <= 2


def test_box_around_face_stays_in_frame():
    x, y, w, h = wd.box_around_face((600.0, 5.0, 40.0, 40.0), 640, 360)
    assert x >= 0 and y >= 0 and x + w <= 640 and y + h <= 360
