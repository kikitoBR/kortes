from pathlib import Path

import pytest

from src.media.ffmpeg import plan_source_windows, source_window_input_args


def test_close_ranges_share_one_seeked_window():
    windows, placed = plan_source_windows([(8000.0, 8010.0), (8010.4, 8030.0)])
    assert windows == [(8000.0, 8030.0)]
    assert [p[0] for p in placed] == [0, 0]
    assert placed[1][1:] == pytest.approx((10.4, 30.0))


def test_teaser_and_distant_ranges_get_their_own_windows():
    teaser = [(9030.0, 9033.0), (9033.0, 9033.5)]  # cold open + rewind placeholder
    body = [(9000.0, 9020.0), (9020.6, 9045.0)]
    windows, placed = plan_source_windows([*teaser, *body])
    # The body plays after the teaser but sits earlier in the source: its own
    # window, so ffmpeg never queues it in memory while the teaser plays.
    assert windows == [(9030.0, 9033.5), (9000.0, 9045.0)]
    assert [p[0] for p in placed] == [0, 0, 1, 1]
    assert placed[2][1:] == pytest.approx((0.0, 20.0))

    windows, _ = plan_source_windows([(100.0, 110.0), (200.0, 210.0)])
    assert windows == [(100.0, 110.0), (200.0, 210.0)]


def test_window_inputs_seek_before_opening_the_source():
    args = source_window_input_args(Path("src.mp4"), [(9030.0, 9033.5)])
    assert args == ["-ss", "9030.000", "-t", "3.500", "-i", str(Path("src.mp4"))]
