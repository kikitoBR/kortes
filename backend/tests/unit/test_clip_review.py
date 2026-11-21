import json

import pytest

from src.ai import ClipAdjustment, ClipReview
from src.clip_review import (
    apply_adjustment,
    apply_review,
    build_adjust_prompt,
    build_review_prompt,
    parse_label,
    segment_from_clip,
)

SEGMENT = {
    "start_time": "10:00",
    "end_time": "10:40",
    "hook_title": "Ele fugiu da polícia",
    "hook_start_time": None,
    "hook_end_time": None,
    "text": "...",
}


def review(**fields):
    return ClipReview.model_validate({"score": 5, **fields})


@pytest.fixture
def timing_path(tmp_path):
    """A source known only by its word timings (the media is gone)."""
    words = []
    for second, word in [(575, "ele"), (577, "roubou"), (580, "o"), (581, "carro."), (602, "CORRE!"),
                         (615, "olha"), (630, "acabou."), (642, "kkkk")]:
        words.append({"text": word, "start": second * 1000, "end": second * 1000 + 600})
    path = tmp_path / "abc123.mp4"
    path.with_suffix(".transcript_cache.json").write_text(json.dumps({"words": words, "source_duration": 3600}))
    return path


def test_labels_parse_hours_and_reject_junk():
    assert parse_label("125:30") == 7530
    assert parse_label("1:02:03") == 3723
    assert parse_label("10m") is None and parse_label(None) is None


def test_a_good_clip_is_left_alone():
    assert apply_review(SEGMENT, review(score=9), teaser_available=True) is None


def test_missing_context_pulls_the_start_back_at_most_15_s():
    fixed, changes = apply_review(
        SEGMENT, review(problems=["missing_context"], start_time="09:50"), teaser_available=True
    )
    assert fixed["start_time"] == "09:50" and "10 s antes" in changes[0]
    # Too far back, or a move the problem does not call for, is ignored.
    assert apply_review(SEGMENT, review(problems=["missing_context"], start_time="09:00"), teaser_available=True) is None
    assert apply_review(SEGMENT, review(problems=["cut_ending"], start_time="09:50"), teaser_available=True) is None


def test_dead_start_and_cut_ending_move_within_limits():
    fixed, changes = apply_review(
        SEGMENT,
        review(problems=["dead_start", "cut_ending"], start_time="10:05", end_time="10:46"),
        teaser_available=True,
    )
    assert (fixed["start_time"], fixed["end_time"]) == ("10:05", "10:46")
    assert len(changes) == 2
    # Never shorter than 15 s.
    short = {**SEGMENT, "end_time": "10:20"}
    assert apply_review(short, review(problems=["dead_start"], start_time="10:08"), teaser_available=True) is None


def test_weak_hook_and_title_fixes():
    fixed, changes = apply_review(
        SEGMENT,
        review(
            problems=["weak_hook", "weak_title"],
            hook_start_time="10:02",
            hook_end_time="10:05",
            hook_title='"CORRE QUE ELE VOLTOU 🔊" #gta',
        ),
        teaser_available=True,
    )
    assert (fixed["hook_start_time"], fixed["hook_end_time"]) == ("10:02", "10:05")
    assert fixed["hook_title"] == "CORRE QUE ELE VOLTOU"
    # No teaser for this task: the hook suggestion is dropped.
    only_title = apply_review(
        SEGMENT, review(problems=["weak_hook"], hook_start_time="10:02", hook_end_time="10:05"), teaser_available=False
    )
    assert only_title is None
    # A teaser outside the clip or too long is refused.
    assert apply_review(
        SEGMENT, review(problems=["weak_hook"], hook_start_time="10:30", hook_end_time="10:50"), teaser_available=True
    ) is None


def test_review_prompt_shows_before_inside_after_and_peaks(timing_path):
    z = [0.0] * 3600
    z[602] = 3.0
    prompt = build_review_prompt(timing_path, SEGMENT, teaser_available=True, voice_energy=z)
    before, rest = prompt.split("\nTHE CLIP:\n")
    inside, after = rest.split("\nAFTER THE CLIP:\n")
    assert "roubou" in before and "CORRE!" in inside and "kkkk" in after
    assert "🔊🔊" in inside and "🔊" not in before + after
    assert "no teaser" in prompt


def test_saved_clip_with_teaser_and_rewind_becomes_a_segment():
    keep = [(602.0, 604.5), (604.5, 605.0), (598.3, 621.0), (621.8, 640.2)]
    segment = segment_from_clip({"text": "x", "hook_title": "T"}, keep)
    assert (segment["start_time"], segment["end_time"]) == ("09:58", "10:40")
    assert (segment["hook_start_time"], segment["hook_end_time"]) == ("10:02", "10:04")
    plain = segment_from_clip({"text": "x"}, [(10.0, 30.0), (31.0, 50.0)])
    assert plain["hook_start_time"] is None and plain["end_time"] == "00:50"


def test_adjustment_is_validated():
    adjusted = apply_adjustment(
        SEGMENT,
        ClipAdjustment(start_time="09:57", end_time="10:40", hook_title="Novo título", reply="Comecei 3 s antes."),
    )
    assert adjusted["start_time"] == "09:57" and adjusted["hook_title"] == "Novo título"
    assert adjusted["hook_start_time"] is None
    with pytest.raises(ValueError, match="menos de 15"):
        apply_adjustment(SEGMENT, ClipAdjustment(start_time="10:00", end_time="10:05", reply="."))
    with pytest.raises(ValueError):
        apply_adjustment(SEGMENT, ClipAdjustment(start_time="amanhã", end_time="10:05", reply="."))


def test_adjust_prompt_carries_the_request_and_nearby_lines(timing_path):
    prompt = build_adjust_prompt(timing_path, SEGMENT, "começa 3 s antes")
    assert 'CREATOR\'S REQUEST: "começa 3 s antes"' in prompt
    assert "roubou" in prompt and "kkkk" in prompt
