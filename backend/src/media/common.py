"""Shared media dependencies and rendering constants."""

from pathlib import Path

from typing import List, Dict, Any, Tuple, Optional

import logging

import numpy as np

from concurrent.futures import ThreadPoolExecutor

import json

import re

import uuid

import shutil

import subprocess

import tempfile

import time

import cv2

import assemblyai as aai

import httpx

import srt

from datetime import timedelta

try:
    import whisper as _whisper

    _WHISPER_AVAILABLE = True
except ImportError:  # pragma: no cover - optional transcription backend
    _whisper = None
    _WHISPER_AVAILABLE = False

from ..config import get_config

from ..clip_cleanup import DEFAULT_FILTERED_WORDS, clip_cleanup_enabled

from ..clip_source_map import (
    normalize_source_ranges,
    save_clip_source_ranges,
    source_range_bounds,
)

from ..caption_templates import get_template, CAPTION_TEMPLATES

from ..emoji_captions import POWER_WORDS, annotate_caption_words, normalize_token

from ..font_registry import FONTS_DIR, find_font_path, get_font_family_name

logger = logging.getLogger(__name__)

TRANSCRIPT_CACHE_SCHEMA_VERSION = 2

VALID_OUTPUT_FORMATS = {
    "vertical",
    "vertical_pan",
    "vertical_split",
    "vertical_gameplay",  # webcam on top, game below
    "vertical_gameplay_bottom",  # game on top, webcam below
    "vertical_cam_float",  # game full screen, webcam floating
    "vertical_blur",  # whole picture over a blurred fill
    "original",
}

# Layouts built around the streamer's webcam (picked by hand or detected).
WEBCAM_OUTPUT_FORMATS = {"vertical_gameplay", "vertical_gameplay_bottom", "vertical_cam_float"}


def normalize_webcam_region(value: Any) -> Optional[Dict[str, float]]:
    """Validate a user-picked facecam box given as 0-1 fractions of the frame.

    Returns {"x", "y", "w", "h"} clamped inside the frame, or None when the
    value is missing or unusable (the renderer then auto-detects the face).
    """
    if not isinstance(value, dict):
        return None
    try:
        x, y, w, h = (float(value[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(v == v and abs(v) != float("inf") for v in (x, y, w, h)):
        return None
    x = min(max(x, 0.0), 1.0)
    y = min(max(y, 0.0), 1.0)
    w = min(max(w, 0.0), 1.0 - x)
    h = min(max(h, 0.0), 1.0 - y)
    if w < 0.03 or h < 0.03:
        return None
    return {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}

EMOJI_FONT_NAME = "Noto Color Emoji"

CLIP_END_SENTENCE_EXTENSION_SECONDS = 3.0

CLIP_END_PADDING_SECONDS = 0.35

CLIP_START_SNAP_WINDOW_SECONDS = 3.0

CLIP_START_LEAD_IN_SECONDS = 0.1

SENTENCE_PAUSE_BOUNDARY_SECONDS = 0.8

HOOK_TEASER_MIN_SECONDS = 1.5

HOOK_TEASER_MAX_SECONDS = 5.0

HOOK_TEASER_MIN_OFFSET_SECONDS = 3.0

# "Ganho inicial": after the cold-open teaser, a short tape-rewind beat plays
# before the clip starts. It replaces a placeholder range of exactly this
# length appended to the teaser, so clip duration, captions and source maps
# stay in sync.
HOOK_REWIND_SECONDS = 0.5

# Long pauses are compressed rather than cut out, so speech keeps a natural
# breath between phrases. A junction keeps PAUSE_EDGE_PADDING_SECONDS of silence
# on each side of the cut; with the junction crossfade (at most
# CROSSFADE_MAX_SECONDS, which overlaps the two sides) about
# PAUSE_RETAINED_SILENCE_SECONDS of silence remains audible. The padding is never
# shorter than the crossfade, so the fade only ever blends silence, never words.
PAUSE_RETAINED_SILENCE_SECONDS = 0.2

CROSSFADE_MAX_SECONDS = 0.15

PAUSE_EDGE_PADDING_SECONDS = (PAUSE_RETAINED_SILENCE_SECONDS + CROSSFADE_MAX_SECONDS) / 2

# Dead air kept before the first word and after the last word of a clip. The
# tail is a little longer because word end timings often land before the final
# consonant has decayed.
PAUSE_LEAD_IN_SECONDS = 0.1

PAUSE_TAIL_SECONDS = 0.25

SENTENCE_END_RE = re.compile(r"""[.!?]["')\]}]*$""")

HOOK_TITLE_SECONDS = 4.0

HOOK_TITLE_MIN_SECONDS = 1.5

HOOK_TITLE_TOP_MARGIN_FRAC = 0.07

ANALYSIS_SEGMENT_MIN_WORDS = 8

ANALYSIS_SEGMENT_MAX_WORDS = 8

ANALYSIS_SEGMENT_MAX_DURATION_MS = 12_000

ANALYSIS_LONG_UTTERANCE_MAX_WORDS = 24

ANALYSIS_LONG_UTTERANCE_MAX_DURATION_MS = 20_000

ANALYSIS_UTTERANCE_SPLIT_THRESHOLD_MS = 45_000

ANALYSIS_UTTERANCE_SPLIT_THRESHOLD_WORDS = 80

_WHISPER_MODEL_CACHE: Dict[str, Any] = {}

FINAL_VIDEO_CRF = 19

FINAL_VIDEO_PRESET = "medium"

INTERMEDIATE_CRF = 16

OUTPUT_FPS = 30

AUDIO_BITRATE = "192k"

LOUDNORM_FILTER = "loudnorm=I=-14:TP=-1.5:LRA=11"

_EMOJI_SUPPORT_CACHE: Optional[bool] = None

FACE_PRESENCE_MIN_AREA = 0.002

FACE_RATE_WINDOW = 2.0

FACE_PRESENCE_RATE = 0.25

MIN_LAYOUT_SECONDS = 1.5

LAYOUT_SNAP_WINDOW = 0.6

KENBURNS_ZOOM_DELTA = 0.05

KENBURNS_MIN_SECONDS = 3.0

KENBURNS_SUPERSAMPLE_W = 1620

KENBURNS_SUPERSAMPLE_H = 2880

# Mild luma-only sharpen applied after the 9:16 upscale; vertical crops are
# usually stretched 1.3-2.7x from the source, which softens edges.
UPSCALE_SHARPEN_FILTER = "unsharp=5:5:0.6:5:5:0.0"

VERTICAL_SCALE_CHAIN = f"scale=1080:1920:flags=lanczos,{UPSCALE_SHARPEN_FILTER},setsar=1"
