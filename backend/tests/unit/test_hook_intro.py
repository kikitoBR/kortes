from pathlib import Path
from unittest.mock import patch

from src.media import timeline
from src.media.common import HOOK_REWIND_SECONDS
from src.media.hook_rewind import build_rewind_filter

BODY = [(5.0, 20.0), (20.6, 40.0)]


def _with_teaser(rewind_seconds, source_duration=600.0):
    with (
        patch.object(timeline, "load_cached_transcript_data", return_value={"words": []}),
        patch.object(timeline, "build_hook_teaser_range", return_value=(30.0, 33.0)),
        patch.object(timeline, "ffprobe_duration", return_value=source_duration),
    ):
        return timeline.add_hook_teaser_to_keep_ranges(
            Path("v.mp4"), BODY, 30.0, 33.0, rewind_seconds=rewind_seconds
        )


def test_rewind_placeholder_follows_the_teaser():
    ranges = _with_teaser(HOOK_REWIND_SECONDS)
    assert ranges[0] == (30.0, 33.0)
    assert ranges[1] == (33.0, 33.0 + HOOK_REWIND_SECONDS)
    assert ranges[2:] == BODY
    # The beat starts right after the 3 s teaser.
    assert timeline.hook_rewind_point(ranges) == 3.0


def test_plain_teaser_has_no_rewind_point():
    ranges = _with_teaser(0.0)
    assert ranges == [(30.0, 33.0), *BODY]
    assert timeline.hook_rewind_point(ranges) is None


def test_no_placeholder_past_the_end_of_the_source():
    ranges = _with_teaser(HOOK_REWIND_SECONDS, source_duration=33.2)
    assert timeline.hook_rewind_point(ranges) is None


def test_cleanup_gaps_are_not_mistaken_for_the_beat():
    # Teaser split by a cleanup cut: its last piece is short but NOT contiguous.
    ranges = [(30.0, 31.5), (31.9, 32.4), *BODY]
    assert timeline.hook_rewind_point(ranges) is None
    assert timeline.hook_rewind_point(BODY) is None


def test_segment_teaser_honours_the_task_choice():
    segment = {"hook_start_time": "00:30", "hook_end_time": "00:33"}
    with patch.object(timeline, "add_hook_teaser_to_keep_ranges", return_value=["teased"]) as add:
        assert timeline.apply_segment_hook_teaser(Path("v.mp4"), BODY, segment, enabled=False) == BODY
        add.assert_not_called()
        timeline.apply_segment_hook_teaser(Path("v.mp4"), BODY, segment, enabled=True, rewind=True)
        assert add.call_args.kwargs["rewind_seconds"] == HOOK_REWIND_SECONDS


def test_rewind_filter_replaces_exactly_the_beat():
    graph = build_rewind_filter(3.0, 30, True, Path("Anton.ttf"), Path("label.txt"))
    assert "trim=end=3.000" in graph
    assert "trim=start=1.500:end=3.000" in graph  # 3x the beat, played backwards
    assert "reverse,setpts=PTS/3" in graph
    assert "trim=start=3.500" in graph
    assert "areverse,atempo=2,atempo=1.5" in graph
    assert "concat=n=3:v=1:a=0" in graph and "concat=n=3:v=0:a=1" in graph
