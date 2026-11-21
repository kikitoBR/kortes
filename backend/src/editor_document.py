"""Versioned, non-destructive clip drafts and deterministic render instructions.

Editor files live beside generated media on the shared temp volume. Originals are
never modified. A file lock and revision check protect concurrent API workers.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Literal
import fcntl
import hashlib
import json
import os
import subprocess
import time
import uuid

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Segment(Model):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        if self.end - self.start < 0.04:
            raise ValueError("Cada trecho deve ter pelo menos um quadro")
        return self


class Word(Model):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=120)
    highlight: bool = False

    @model_validator(mode="after")
    def ordered(self):
        if self.end <= self.start:
            raise ValueError("O fim da legenda deve vir depois do início")
        return self


class CaptionStyle(Model):
    enabled: bool = True
    font: Literal["TikTokSans-Regular", "Poppins-ExtraBold", "THEBOLDFONT"] = (
        "Poppins-ExtraBold"
    )
    size: int = Field(default=54, ge=20, le=100)
    color: str = Field(default="#FFFFFF", pattern=r"^#[0-9a-fA-F]{6}$")
    accent: str = Field(default="#FACC15", pattern=r"^#[0-9a-fA-F]{6}$")
    y: float = Field(default=0.78, ge=0.1, le=0.9)
    background: bool = True
    wordsPerLine: int = Field(default=4, ge=1, le=8)


class WebcamBox(Model):
    """Where the streamer's webcam sits, as 0-1 fractions of the source frame."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0.02, le=1)
    h: float = Field(ge=0.02, le=1)

    @model_validator(mode="after")
    def inside(self):
        if self.x + self.w > 1.001 or self.y + self.h > 1.001:
            raise ValueError("A área da webcam precisa ficar dentro do vídeo")
        return self


class Framing(Model):
    aspect: Literal["vertical", "square", "original"] = "vertical"
    fit: Literal["contain", "cover"] = "cover"
    # zoom/x/y place the picture; in the gameplay layout they place the game cut.
    zoom: float = Field(default=1, ge=1, le=3)
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)
    # "gameplay": the webcam box on top (1080x768), the game below (1080x1152).
    layout: Literal["single", "gameplay"] = "single"
    webcam: WebcamBox | None = None

    @model_validator(mode="after")
    def gameplay_needs_webcam(self):
        if self.layout == "gameplay" and self.webcam is None:
            raise ValueError("Marque a webcam para usar o layout webcam + jogo")
        return self


class Effects(Model):
    brightness: float = Field(default=100, ge=40, le=180)
    contrast: float = Field(default=100, ge=40, le=180)
    saturation: float = Field(default=100, ge=0, le=220)
    blur: float = Field(default=0, ge=0, le=8)
    hue: float = Field(default=0, ge=-180, le=180)


class EditDocument(Model):
    version: Literal[1] = 1
    segments: list[Segment] = Field(min_length=1, max_length=100)
    words: list[Word] = Field(default_factory=list, max_length=5000)
    captions: CaptionStyle = Field(default_factory=CaptionStyle)
    framing: Framing = Field(default_factory=Framing)
    effects: Effects = Field(default_factory=Effects)
    volume: float = Field(default=1, ge=0, le=2)
    muted: bool = False

    def validate_duration(self, duration: float):
        if any(s.end > duration + 0.05 for s in self.segments):
            raise ValueError("Uma edição ultrapassa o clipe original")
        if any(w.end > duration + 0.05 for w in self.words):
            raise ValueError("Uma legenda ultrapassa o clipe original")
        if len({s.id for s in self.segments}) != len(self.segments) or len(
            {w.id for w in self.words}
        ) != len(self.words):
            raise ValueError("Editor item IDs must be unique")
        return self


def editor_dir(temp_dir: str, task_id: str, clip_id: str, filename: str) -> Path:
    # No request-controlled string is ever used as a path component.
    key = hashlib.sha256(f"{task_id}:{clip_id}:{filename}".encode()).hexdigest()
    return Path(temp_dir) / "editor" / key


def atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    try:
        temporary.write_text(json.dumps(value, allow_nan=False))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def editor_lock(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class RevisionConflict(ValueError):
    pass


def save_document(
    directory: Path, document: EditDocument, revision: int, duration: float
):
    document.validate_duration(duration)
    with editor_lock(directory):
        path = directory / "draft.json"
        current = json.loads(path.read_text()) if path.exists() else {"revision": 0}
        if revision != current["revision"]:
            raise RevisionConflict(
                "This clip was edited in another tab. Reload the saved draft before continuing."
            )
        payload = {"revision": revision + 1, "document": document.model_dump()}
        atomic_json(path, payload)
        return payload


def is_gameplay(framing: Framing) -> bool:
    return framing.layout == "gameplay" and framing.webcam is not None


# Share of the frame height taken by the webcam tile (768 of 1920).
GAMEPLAY_CAM_SHARE = 768 / 1920


def webcam_cut(box: WebcamBox, sw: float, sh: float, aspect: float):
    """Source rect (x, y, w, h) for the webcam tile: the box cover-fitted to the
    tile aspect around its centre, so the tile fills without stretching."""
    bw, bh = box.w * sw, box.h * sh
    if bw / bh > aspect:
        cw, ch = bh * aspect, bh
    else:
        cw, ch = bw, bw / aspect
    cx, cy = (box.x + box.w / 2) * sw, (box.y + box.h / 2) * sh
    return (
        min(max(cx - cw / 2, 0), sw - cw),
        min(max(cy - ch / 2, 0), sh - ch),
        cw,
        ch,
    )


def game_cut(framing: Framing, sw: float, sh: float, aspect: float):
    """Source rect for the game tile: a full-height cut at the tile aspect,
    narrowed by ``zoom`` and slid by ``x``/``y``."""
    gh = sh / framing.zoom
    gw = gh * aspect
    if gw > sw:
        gw, gh = sw, sw / aspect
    return (sw - gw) * framing.x, (sh - gh) * framing.y, gw, gh


def gameplay_tile_heights(height: int):
    cam = round(height * GAMEPLAY_CAM_SHARE / 2) * 2
    return cam, height - cam


def _even_crop(rect, sw: int, sh: int) -> str:
    x, y, w, h = rect
    cw = max(2, min(sw, int(w) // 2 * 2))
    ch = max(2, min(sh, int(h) // 2 * 2))
    return f"crop={cw}:{ch}:{min(int(x), sw - cw)}:{min(int(y), sh - ch)}"


def gameplay_geometry(framing: Framing, sw: int, sh: int, width: int, height: int) -> str:
    """Filter chain body that stacks the webcam cut over the game cut."""
    cam_h, game_h = gameplay_tile_heights(height)
    cam = webcam_cut(framing.webcam, sw, sh, width / cam_h)
    game = game_cut(framing, sw, sh, width / game_h)
    return (
        "split=2[gpcam][gpgame];"
        f"[gpcam]{_even_crop(cam, sw, sh)},scale={width}:{cam_h},setsar=1[gpcamv];"
        f"[gpgame]{_even_crop(game, sw, sh)},scale={width}:{game_h},setsar=1[gpgamev];"
        "[gpcamv][gpgamev]vstack,setsar=1"
    )


def output_size(document: EditDocument, width: int, height: int):
    if is_gameplay(document.framing):
        return 1080, 1920
    if document.framing.aspect == "square":
        return 1080, 1080
    if document.framing.aspect == "vertical":
        return 1080, 1920
    scale = min(1, 1920 / max(width, height))
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def mapped_words(document: EditDocument):
    result = []
    cursor = 0.0
    ordered_words = sorted(document.words, key=lambda w: w.start)
    for segment in document.segments:
        for word in ordered_words:
            start, end = max(segment.start, word.start), min(segment.end, word.end)
            if end > start and word.text.strip():
                result.append(
                    {
                        **word.model_dump(),
                        "start": cursor + start - segment.start,
                        "end": cursor + end - segment.start,
                    }
                )
        cursor += segment.end - segment.start
    return result


def caption_groups(words: list[dict], count: int):
    groups, group = [], []
    for word in words:
        if group and (len(group) >= count or word["start"] - group[-1]["end"] > 0.6):
            groups.append(group)
            group = []
        group.append(word)
    if group:
        groups.append(group)
    return groups


def write_ass(path: Path, document: EditDocument, width: int, height: int):
    from .clip_editor import _ass_color, _ass_timestamp, _escape_ass_text
    from .font_registry import get_font_family_name, find_font_path
    from .media.captions import CaptionFontCoverage

    style = document.captions
    size = style.size * width / 1080
    font_path = find_font_path(style.font)
    font = (get_font_family_name(font_path) if font_path else None) or "Arial"
    coverage = CaptionFontCoverage(style.font if font_path else None, font)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{_ass_color(style.color)},&H000000FF,&H00101010,&H80101010,0,0,0,0,100,100,0,0,{3 if style.background else 1},{max(1, size * 0.1) if style.background else max(1, size * 0.04)},0,5,{int(width * 0.08)},{int(width * 0.08)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    if style.enabled:
        for group in caption_groups(mapped_words(document), style.wordsPerLine):
            text = " ".join(
                "{\\c"
                + _ass_color(style.accent if word["highlight"] else style.color)
                + "}"
                + coverage.render(
                    _escape_ass_text(coverage.prepare(word["text"]))
                    .replace("\n", " ")
                    .replace("\r", " "),
                    size,
                )
                for word in group
            )
            position = f"{{\\pos({width / 2:.2f},{height * style.y:.2f})}}"
            lines.append(
                f"Dialogue: 0,{_ass_timestamp(group[0]['start'])},{_ass_timestamp(max(w['end'] for w in group))},Default,,0,0,0,,{position}{text}\n"
            )
    path.write_text(header + "".join(lines))


def run_render(command: list[str], directory: Path, job_id: str, duration: float):
    """Poll a cancellable child without buffering unbounded ffmpeg logs."""
    status_path = directory / f"job-{job_id}.json"
    progress_path = directory / f"progress-{job_id}.txt"
    log_path = directory / f"log-{job_id}.txt"
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            command[:1] + ["-progress", str(progress_path), "-nostats"] + command[1:],
            stdout=subprocess.DEVNULL,
            stderr=log,
        )
        try:
            while process.poll() is None:
                if (directory / f"cancel-{job_id}").exists():
                    raise InterruptedError("Export cancelled")
                percent = 0
                if progress_path.exists():
                    for line in progress_path.read_text().splitlines():
                        if line.startswith("out_time_us="):
                            try:
                                percent = min(
                                    99,
                                    int(
                                        float(line.split("=", 1)[1])
                                        / 1_000_000
                                        / duration
                                        * 100
                                    ),
                                )
                            except ValueError:
                                pass
                atomic_json(status_path, {"status": "rendering", "progress": percent})
                time.sleep(0.25)
            if process.returncode:
                log.seek(0)
                raise RuntimeError("Video rendering failed: " + log.read()[-1500:])
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            progress_path.unlink(missing_ok=True)
            log_path.unlink(missing_ok=True)


def render_document(directory: Path, job_id: str, document: EditDocument, preset: str):
    from .clip_editor import _ffprobe_size, _escape_filter_path
    from .video_utils import ass_fonts_dir

    source = directory / "clean.mp4"
    sw, sh = _ffprobe_size(source)
    width, height = output_size(document, sw, sh)
    framing, fx = document.framing, document.effects
    scale = (max if framing.fit == "cover" else min)(
        width / sw, height / sh
    ) * framing.zoom
    rw, rh = max(2, round(sw * scale / 2) * 2), max(2, round(sh * scale / 2) * 2)
    # Crop overflow and position letterboxing using the same normalized anchor.
    cw, ch = min(width, rw), min(height, rh)
    geometry = (
        gameplay_geometry(framing, sw, sh, width, height)
        if is_gameplay(framing)
        else f"scale={rw}:{rh},crop={cw}:{ch}:{(rw - cw) * framing.x}:{(rh - ch) * framing.y},pad={width}:{height}:{(width - cw) * framing.x}:{(height - ch) * framing.y}:black,setsar=1"
    )
    # CSS brightness/contrast use RGB multiplication followed by a midpoint shift.
    gain = fx.brightness / 100 * fx.contrast / 100
    offset = 128 * (1 - fx.contrast / 100)
    effects = f"lutrgb=r='clip(val*{gain}+{offset},0,255)':g='clip(val*{gain}+{offset},0,255)':b='clip(val*{gain}+{offset},0,255)',hue=h={fx.hue}:s={fx.saturation / 100}"
    if fx.blur:
        effects += f",gblur=sigma={fx.blur * width / 1080}"
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    audio = bool(probe.stdout.strip())
    filters, joins = [], []
    for index, segment in enumerate(document.segments):
        filters.append(
            f"[0:v]trim=start={segment.start}:end={segment.end},setpts=PTS-STARTPTS[v{index}]"
        )
        joins.append(f"[v{index}]")
        if audio:
            filters.append(
                f"[0:a]atrim=start={segment.start}:end={segment.end},asetpts=PTS-STARTPTS[a{index}]"
            )
            joins.append(f"[a{index}]")
    filters.append(
        "".join(joins)
        + f"concat=n={len(document.segments)}:v=1:a={int(audio)}[video]"
        + ("[audio]" if audio else "")
    )
    ass = directory / f"captions-{job_id}.ass"
    write_ass(ass, document, width, height)
    fonts = ass_fonts_dir(document.captions.font)
    filters.append(
        f"[video]{geometry},{effects},ass={_escape_filter_path(ass)}:fontsdir={_escape_filter_path(fonts or Path('fonts'))}[outv]"
    )
    if audio:
        filters.append(
            f"[audio]volume={0 if document.muted else document.volume}[outa]"
        )
    output = directory / f"export-{job_id}.mp4"
    temporary = directory / f".export-{job_id}.mp4"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[outv]",
    ]
    if audio:
        command += ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"]
    command += [
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-maxrate",
        "12M" if preset == "reels" else "10M",
        "-bufsize",
        "24M",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    try:
        run_render(
            command, directory, job_id, sum(s.end - s.start for s in document.segments)
        )
        if (directory / f"cancel-{job_id}").exists():
            raise InterruptedError("Export cancelled")
        temporary.replace(output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        ass.unlink(missing_ok=True)
