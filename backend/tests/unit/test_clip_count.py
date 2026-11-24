"""'Cortes por vídeo': automatic or a number the user picked in Configurações."""

import pytest

from src.ai import (
    build_transcript_analysis_prompt,
    clip_count_targets,
    max_final_clips_for_duration,
    normalize_clip_count,
)
from src.api.routes.tasks import _merge_task_source_metadata
from src.services.task_service import TaskService


@pytest.mark.parametrize("value, expected", [(5, 5), ("20", 20), (10, 10), (15, 15), (None, None), ("auto", None), (12, None), (0, None)])
def test_only_the_offered_counts_are_kept(value, expected):
    assert normalize_clip_count(value) == expected


def test_a_picked_count_asks_the_ai_for_enough_moments():
    assert clip_count_targets(None, 4) == (None, None)  # automatic keeps today's prompts
    # 5 is what the default prompts already ask for ("2-5", "3-5" per window).
    assert clip_count_targets(5, 1)[0] is None and clip_count_targets(5, 3) == (None, None)
    assert clip_count_targets(20, 1)[0] == "18-20"
    # Spread over the windows, with room for the duplicates dropped later.
    assert clip_count_targets(20, 3)[1] == "8-10"
    prompt = build_transcript_analysis_prompt("[00:00 - 00:05] oi", segment_target="18-20")
    assert "Choose 18-20 segments total." in prompt


def test_automatic_scales_with_the_video_up_to_the_cap():
    assert max_final_clips_for_duration(10 * 60, 20) == 5
    assert max_final_clips_for_duration(60 * 60, 20) == 12
    assert max_final_clips_for_duration(3 * 3600, 20) == 20
    assert max_final_clips_for_duration(3 * 3600, 10) == 10


def test_the_count_is_saved_with_the_task_and_splits_the_analysis_cache():
    merged = _merge_task_source_metadata({}, clip_count=15)
    assert merged["clip_count"] == 15
    assert "clip_count" not in _merge_task_source_metadata({}, clip_count="auto")
    auto = TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast")
    picked = TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast", clip_count=15)
    assert auto != picked
    assert auto == TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast", clip_count=None)


def test_strictness_more_asks_for_more_and_best_keeps_the_strongest():
    from src.ai import MORE_CLIPS_SECONDS_PER_CLIP
    from src.services.task_service import strongest_segments

    assert clip_count_targets(None, 1, "more") == ("4-8", "4-6")
    assert max_final_clips_for_duration(60 * 60, 20, MORE_CLIPS_SECONDS_PER_CLIP) == 20
    assert max_final_clips_for_duration(30 * 60, 20, MORE_CLIPS_SECONDS_PER_CLIP) == 10
    scored = [{"virality_score": v, "n": i} for i, v in enumerate([90, 50, 75, 40, 60])]
    assert [s["n"] for s in strongest_segments(scored)] == [0, 2, 4]  # 70+ and never fewer than 3
    weak = [{"virality_score": v} for v in (50, 40, 30, 20)]
    assert len(strongest_segments(weak)) == 3
    more = TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast", strictness="more")
    assert more != TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast", strictness="best")
    assert TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast", strictness="best") == (
        TaskService._build_cache_key("https://youtu.be/x", "youtube", "fast")
    )


def test_strictness_and_title_are_saved_with_the_task_and_reach_the_live():
    from src.api.routes.tasks import LIVE_MIN_SCORES
    from src.live.session import LiveOptions, LiveSession

    merged = _merge_task_source_metadata({}, strictness="best", title_overlay=False)
    assert merged["strictness"] == "best" and merged["title_overlay"] is False
    assert "title_overlay" not in _merge_task_source_metadata({}, title_overlay=True)
    assert "strictness" not in _merge_task_source_metadata({}, strictness="max")
    assert LIVE_MIN_SCORES == {"more": 5, "best": 8}

    class Hooks:
        pass

    session = LiveSession("task-strict", LiveOptions(min_score=8, title_overlay=False), Hooks())
    assert session.min_score == 8 and session.options.title_overlay is False
    assert LiveSession("task-default", LiveOptions(), Hooks()).min_score == 6


def test_cuts_are_copied_to_the_chosen_folder(tmp_path):
    from src.desktop import copy_clip_to_folder

    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")
    first = copy_clip_to_folder(str(tmp_path / "out"), 'Live: "teste" 24/11?', str(clip), 3, "Que susto! <grito>")
    assert first.parent.name == "Live teste 24 11" and first.name == "03 - Que susto! grito.mp4"
    # A re-render with a new title replaces the cut, never piles up copies.
    second = copy_clip_to_folder(str(tmp_path / "out"), 'Live: "teste" 24/11?', str(clip), 3, "Título novo")
    assert [p.name for p in second.parent.iterdir()] == ["03 - Título novo.mp4"]
    assert copy_clip_to_folder("", "x", str(clip), 1, "t") is None
