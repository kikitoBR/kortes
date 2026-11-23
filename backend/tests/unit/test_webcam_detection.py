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


def test_webcam_against_the_frame_side_reaches_it_past_the_shelves():
    # The webcam sits in the top-left corner (x 0-200, y 80-200): no game on its
    # left, and a shelf edge inside it at x 60. Its left side is the frame edge.
    rng = np.random.default_rng(5)
    room = np.full((120, 200), 70.0, dtype=np.float32)
    room[:, 60:] = 150.0
    frames = []
    for _ in range(24):
        game = rng.uniform(0, 255, size=(360, 640)).astype(np.float32)
        game = (game + np.roll(game, 1, axis=1) + np.roll(game, 1, axis=0)) / 3
        game[80:200, 0:200] = room
        frames.append(game)
    face = (110.0, 100.0, 36.0, 36.0)
    (x, y, w, h), _ = wd.webcam_edges(np.stack(frames), face, wd.box_around_face(face, 640, 360))
    assert x == 0
    assert abs((x + w) - 200) <= 2


def test_a_moving_streamer_does_not_stretch_the_webcam_into_a_still_game():
    # Webcam x 0-200, y 60-180 (5:3). The streamer's body moves at its bottom;
    # under it the game is still (a dark wall) down to y 280, where it moves.
    # The motion jump at 280 is the game, not the webcam: the box would be taller
    # than wide, so the steady line at 180 is its bottom.
    rng = np.random.default_rng(9)
    frames = []
    for _ in range(24):
        game = rng.uniform(0, 255, size=(360, 640)).astype(np.float32)
        game = (game + np.roll(game, 1, axis=1) + np.roll(game, 1, axis=0)) / 3
        game[60:180, 0:200] = 140.0
        body = np.full((50, 120), 150.0 + rng.uniform(-6, 6), dtype=np.float32)  # sways a little
        game[130:180, 40:160] = body
        game[180:280, 0:300] = 20.0
        frames.append(game)
    face = (80.0, 70.0, 40.0, 40.0)
    (x, y, w, h), _ = wd.webcam_edges(np.stack(frames), face, wd.box_around_face(face, 640, 360))
    assert abs((y + h) - 180) <= 3
    assert w / h > 1.2
