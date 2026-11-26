"""How the AI's hook title (and the cover text) looks: a style of band behind the
text, where it sits, its colour, size and how long it stays.

Shared by the burned-in title (`captions.build_hook_title_ass`) and the cover
(`covers.render_clip_cover`), and mirrored by the app's preview
(`frontend/src/lib/title-style.ts`): change the three together.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

# preset id -> what is drawn
#   classico: white text, black outline, power words in the accent colour
#   faixa:    dark translucent band behind every line, white text
#   duas_cores: first lines on a white band (black text), last line on the accent band
#   faixa_cor: every line on the accent band, white text
#   destaque: accent-coloured text with a heavy black outline
PRESETS = ("classico", "faixa", "duas_cores", "faixa_cor", "destaque")
# position id -> centre of the title block, as a share of the frame height
POSITIONS: Dict[str, float] = {
    "top": 0.11,
    "upper": 0.40,  # the webcam/game line of "Webcam em cima"
    "middle": 0.50,
    "lower": 0.62,
    "bottom": 0.84,
}
SIZES = {"s": 0.85, "m": 1.0, "l": 1.2}
DURATIONS = ("start", "always")

DEFAULT_TITLE_STYLE: Dict[str, Any] = {
    "preset": "duas_cores",
    "position": "auto",
    "color": "#E11D2E",
    "size": "m",
    "duration": "start",
}

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def normalize_title_style(value: Any) -> Dict[str, Any]:
    """A valid style from whatever was saved; unknown or missing keys take the default."""
    raw = value if isinstance(value, dict) else {}
    style = dict(DEFAULT_TITLE_STYLE)
    if raw.get("preset") in PRESETS:
        style["preset"] = raw["preset"]
    if raw.get("position") == "auto" or raw.get("position") in POSITIONS:
        style["position"] = raw["position"]
    if isinstance(raw.get("color"), str) and _HEX.match(raw["color"]):
        style["color"] = raw["color"].upper()
    if raw.get("size") in SIZES:
        style["size"] = raw["size"]
    if raw.get("duration") in DURATIONS:
        style["duration"] = raw["duration"]
    return style


def title_center(style: Dict[str, Any], output_format: Optional[str]) -> float:
    """Centre of the title block as a share of the height. "auto" sits on the
    webcam/game line of the webcam layouts and at the top otherwise."""
    position = style.get("position", "auto")
    if position in POSITIONS:
        return POSITIONS[position]
    if output_format == "vertical_gameplay":
        return 0.40  # webcam 768 px over the game: the line is at 768/1920
    if output_format == "vertical_gameplay_bottom":
        return 0.60  # game on top, webcam below
    return POSITIONS["top"]
