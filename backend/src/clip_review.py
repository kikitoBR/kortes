"""Final clip review and text adjustments: what the AI reads and how its answer
changes a clip.

Both produce a new segment (start, end, teaser, on-screen title) that is then
rendered from the source the same way the first render was, so cleanup cuts,
sentence snapping, the teaser and the rewind all keep working.

The rules come from SHARINGAN's reviewer and change requests
(src/cortes/contexto.ts, src/cortes/ajustar.ts; MIT licence, (c) 2026 the
SHARINGAN authors). Every move is bounded here, whatever the model answers.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .ai import ClipAdjustment, ClipReview, sanitize_hook_title
from .media.common import HOOK_REWIND_SECONDS
from .media.transcription import _format_words_for_analysis, load_cached_transcript_data
from .media.voice_energy import annotate_transcript

REVIEW_PASS_SCORE = 8
CONTEXT_BEFORE_SECONDS = 30
CONTEXT_AFTER_SECONDS = 20
MAX_PULL_START_SECONDS = 15
MAX_TRIM_START_SECONDS = 8
MAX_EXTEND_END_SECONDS = 8
ADJUST_CONTEXT_SECONDS = 90
MIN_CLIP_SECONDS = 15
MAX_ADJUSTED_CLIP_SECONDS = 180
TEASER_MIN_SECONDS = 1
TEASER_MAX_SECONDS = 6

_LABEL_RE = re.compile(r"^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*$")


def parse_label(value: Any) -> Optional[float]:
    """Seconds of an "MM:SS" / "H:MM:SS" label; None when it is not one."""
    match = _LABEL_RE.match(str(value or ""))
    if not match:
        return None
    first, second, third = match.groups()
    if third is not None:
        return int(first) * 3600 + int(second) * 60 + int(third)
    return int(first) * 60 + int(second)


def label(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    return f"{total // 60:02d}:{total % 60:02d}"


def segment_bounds(segment: Dict[str, Any]) -> Tuple[float, float]:
    start = parse_label(segment.get("start_time"))
    end = parse_label(segment.get("end_time"))
    if start is None or end is None or end <= start:
        raise ValueError("O clipe não tem início e fim válidos")
    return start, end


def transcript_excerpt(
    video_path: Path, start: float, end: float, voice_energy: Optional[Sequence[float]] = None
) -> str:
    """Timestamped transcript lines of [start, end], with voice peaks marked."""
    data = load_cached_transcript_data(video_path) or {}
    words = [
        SimpleNamespace(text=str(w.get("text") or ""), start=int(w["start"]), end=int(w["end"]))
        for w in data.get("words") or []
        if w.get("end", 0) > start * 1000 and w.get("start", 0) < end * 1000
    ]
    text = "\n".join(_format_words_for_analysis(words))
    return annotate_transcript(text, voice_energy) if voice_energy else text


def build_review_prompt(
    video_path: Path,
    segment: Dict[str, Any],
    *,
    teaser_available: bool,
    voice_energy: Optional[Sequence[float]] = None,
) -> str:
    start, end = segment_bounds(segment)
    before = transcript_excerpt(video_path, max(0, start - CONTEXT_BEFORE_SECONDS), start, voice_energy)
    inside = transcript_excerpt(video_path, start, end, voice_energy)
    after = transcript_excerpt(video_path, end, end + CONTEXT_AFTER_SECONDS, voice_energy)
    hook_start, hook_end = parse_label(segment.get("hook_start_time")), parse_label(segment.get("hook_end_time"))
    if not teaser_available:
        opening = (
            "This clip has no teaser: it opens straight on its first line. "
            "For a weak hook, move start_time later (dead_start) to open closer to the peak."
        )
    elif hook_start is not None and hook_end is not None:
        opening = (
            f"The clip opens with a teaser of {label(hook_start)}-{label(hook_end)} "
            "(that line plays first, then the story starts). For a weak hook, pick a stronger "
            "2-5 s line inside the clip as hook_start_time/hook_end_time."
        )
    else:
        opening = (
            "The clip opens on its first line, with no teaser. For a weak hook, pick the "
            "strongest 2-5 s line inside the clip as hook_start_time/hook_end_time; it will play first."
        )
    return "\n".join(
        [
            f"CLIP: {label(start)} - {label(end)} ({int(end - start)} s of the source).",
            f'On-screen title: "{segment.get("hook_title") or "(none)"}"',
            opening,
            "",
            "BEFORE THE CLIP:",
            before or "(nothing said)",
            "",
            "THE CLIP:",
            inside or "(nothing said)",
            "",
            "AFTER THE CLIP:",
            after or "(nothing said)",
        ]
    )


def apply_review(
    segment: Dict[str, Any], review: ClipReview, *, teaser_available: bool
) -> Optional[Tuple[Dict[str, Any], List[str]]]:
    """The segment with the reviewer's fixes, bounded; None when nothing changes."""
    problems = set(review.problems)
    if not problems:
        return None
    start, end = segment_bounds(segment)
    new_start, new_end = start, end
    changes: List[str] = []

    proposed = parse_label(review.start_time)
    if proposed is not None:
        if "missing_context" in problems and start - MAX_PULL_START_SECONDS - 0.5 <= proposed <= start - 1:
            new_start = max(0.0, proposed)
            changes.append(f"começa {start - new_start:.0f} s antes para dar contexto")
        elif "dead_start" in problems and start + 1 <= proposed <= start + MAX_TRIM_START_SECONDS + 0.5:
            new_start = proposed
            changes.append(f"cortei {new_start - start:.0f} s de começo parado")
    proposed = parse_label(review.end_time)
    if proposed is not None and "cut_ending" in problems and end + 1 <= proposed <= end + MAX_EXTEND_END_SECONDS + 0.5:
        new_end = proposed
        changes.append(f"termina {new_end - end:.0f} s depois para a reação caber")
    if new_end - new_start < MIN_CLIP_SECONDS:
        new_start, new_end, changes = start, end, []

    fixed = dict(segment)
    if (new_start, new_end) != (start, end):
        fixed["start_time"], fixed["end_time"] = label(new_start), label(new_end)

    if "weak_hook" in problems and teaser_available:
        hook_start, hook_end = parse_label(review.hook_start_time), parse_label(review.hook_end_time)
        if (
            hook_start is not None
            and hook_end is not None
            and new_start <= hook_start < hook_end <= new_end
            and TEASER_MIN_SECONDS <= hook_end - hook_start <= TEASER_MAX_SECONDS
            and (label(hook_start), label(hook_end))
            != (segment.get("hook_start_time"), segment.get("hook_end_time"))
        ):
            fixed["hook_start_time"], fixed["hook_end_time"] = label(hook_start), label(hook_end)
            changes.append("gancho novo no começo")
    if "weak_title" in problems:
        title = sanitize_hook_title(review.hook_title)
        if title and title != segment.get("hook_title"):
            fixed["hook_title"] = title
            changes.append(f'título novo: "{title}"')
    return (fixed, changes) if changes else None


def build_adjust_prompt(
    video_path: Path,
    segment: Dict[str, Any],
    instructions: str,
    *,
    voice_energy: Optional[Sequence[float]] = None,
) -> str:
    start, end = segment_bounds(segment)
    nearby = transcript_excerpt(
        video_path, max(0, start - ADJUST_CONTEXT_SECONDS), end + ADJUST_CONTEXT_SECONDS, voice_energy
    )
    teaser = (
        f'{segment.get("hook_start_time")} - {segment.get("hook_end_time")}'
        if segment.get("hook_start_time") and segment.get("hook_end_time")
        else "(none)"
    )
    return "\n".join(
        [
            "CURRENT CLIP",
            f"start_time: {label(start)}",
            f"end_time: {label(end)}",
            f'hook_title: "{segment.get("hook_title") or ""}"',
            f"teaser (plays first): {teaser}",
            "",
            "TRANSCRIPT AROUND THE CLIP (🔊 = volume peak):",
            nearby or "(no transcript)",
            "",
            f'CREATOR\'S REQUEST: "{instructions.strip()[:500]}"',
            "",
            "Return every field (start_time, end_time, hook_title, hook_start_time, hook_end_time, reply); "
            "keep the current value of anything the request does not touch.",
        ]
    )


def apply_adjustment(segment: Dict[str, Any], adjustment: ClipAdjustment) -> Dict[str, Any]:
    """The adjusted segment, validated; raises ValueError with a message for the user."""
    start, end = parse_label(adjustment.start_time), parse_label(adjustment.end_time)
    if start is None or end is None or end <= start:
        raise ValueError("Não entendi o pedido. Tente dizer de outro jeito.")
    if end - start < MIN_CLIP_SECONDS:
        raise ValueError(f"O clipe ficaria com menos de {MIN_CLIP_SECONDS} s.")
    if end - start > MAX_ADJUSTED_CLIP_SECONDS:
        raise ValueError("O clipe ficaria com mais de 3 minutos.")
    adjusted = dict(segment)
    adjusted["start_time"], adjusted["end_time"] = label(start), label(end)
    title = sanitize_hook_title(adjustment.hook_title) if adjustment.hook_title is not None else None
    adjusted["hook_title"] = title if adjustment.hook_title is not None else segment.get("hook_title")
    hook_start, hook_end = parse_label(adjustment.hook_start_time), parse_label(adjustment.hook_end_time)
    if (
        hook_start is not None
        and hook_end is not None
        and start <= hook_start < hook_end <= end
        and TEASER_MIN_SECONDS <= hook_end - hook_start <= TEASER_MAX_SECONDS
    ):
        adjusted["hook_start_time"], adjusted["hook_end_time"] = label(hook_start), label(hook_end)
    else:
        adjusted["hook_start_time"] = adjusted["hook_end_time"] = None
    return adjusted


def segment_from_clip(clip: Dict[str, Any], keep_ranges: Sequence[Tuple[float, float]]) -> Dict[str, Any]:
    """A saved clip as a segment: its story bounds and, if any, its teaser.

    A teaser is the opening range that lies later in the source than the
    range after it (it plays first but happens later).
    """
    ranges = [(float(a), float(b)) for a, b in keep_ranges]
    teaser: Optional[Tuple[float, float]] = None
    body = ranges
    cut = next((i for i in range(1, len(ranges)) if ranges[i][0] < ranges[0][0]), None)
    if cut is not None:
        # The teaser (and the rewind placeholder right after it) plays first.
        teaser_ranges = ranges[:cut]
        last = teaser_ranges[-1]
        if (
            len(teaser_ranges) > 1
            and abs((last[1] - last[0]) - HOOK_REWIND_SECONDS) < 0.05
            and abs(last[0] - teaser_ranges[-2][1]) < 0.05
        ):
            teaser_ranges = teaser_ranges[:-1]
        teaser = (teaser_ranges[0][0], teaser_ranges[-1][1])
        body = ranges[cut:]
    start = min(a for a, _ in body)
    end = max(b for _, b in body)
    return {
        "start_time": label(start),
        "end_time": label(end),
        "text": clip.get("text") or "",
        "relevance_score": clip.get("relevance_score", 0.5),
        "reasoning": clip.get("reasoning") or "",
        "virality_score": clip.get("virality_score", 0),
        "hook_score": clip.get("hook_score", 0),
        "engagement_score": clip.get("engagement_score", 0),
        "value_score": clip.get("value_score", 0),
        "shareability_score": clip.get("shareability_score", 0),
        "hook_type": clip.get("hook_type"),
        "hook_title": clip.get("hook_title"),
        "hook_start_time": label(teaser[0]) if teaser else None,
        "hook_end_time": label(teaser[1]) if teaser else None,
    }
