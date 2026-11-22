"""Section downloads against a local server that answers byte ranges like YouTube."""

import shutil
import subprocess
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from src.youtube_sections import _boxes, _fast_download, sidx_fragments

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")

FLASH_AT = 25.0  # a white flash and a beep at the same source second


class RangeHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = Path(self.translate_path(self.path))
        data = path.read_bytes()
        header = self.headers.get("Range")
        if not header:
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        start, end = (int(v) for v in header.removeprefix("bytes=").split("-"))
        chunk = data[start : end + 1]
        self.send_response(206)
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        self.wfile.write(chunk)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    root = tmp_path_factory.mktemp("yt")
    fragmented = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof+global_sidx"]
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
            "-i", "testsrc2=size=320x180:rate=24:duration=60",
            "-vf", f"drawbox=t=fill:color=white:enable='between(t,{FLASH_AT},{FLASH_AT + 0.25})'",
            "-c:v", "libx264", "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
            "-pix_fmt", "yuv420p", *fragmented, str(root / "video.mp4"),
        ],
        check=True, capture_output=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
            "-i", f"aevalsrc='if(between(t,{FLASH_AT},{FLASH_AT + 0.25}),0.8*sin(2*PI*1000*t),0)':s=48000:d=60",
            "-c:a", "aac", "-frag_duration", "5000000", *fragmented, str(root / "audio.m4a"),
        ],
        check=True, capture_output=True,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(RangeHandler, directory=str(root)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    yield root, {
        "duration": 60,
        "requested_formats": [
            {"url": f"{base}/video.mp4", "protocol": "http", "ext": "mp4", "vcodec": "avc1", "acodec": "none"},
            {"url": f"{base}/audio.m4a", "protocol": "http", "ext": "m4a", "vcodec": "none", "acodec": "mp4a"},
        ],
    }
    server.shutdown()


def first_flash(path: Path) -> float:
    frames = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout
    means = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 32 * 18).mean(axis=1)
    return float(np.argmax(means > 200)) / 24


def first_beep(path: Path) -> float:
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    samples = np.abs(np.frombuffer(pcm, dtype=np.float32))
    return float(np.argmax(samples > 0.2)) / 8000


def test_index_lists_every_fragment(served):
    root, _ = served
    data = (root / "video.mp4").read_bytes()[: 256 << 10]
    boxes = {kind: (start, end) for kind, start, end in _boxes(data)}
    assert "moov" in boxes and "sidx" in boxes
    fragments = sidx_fragments(data, *boxes["sidx"])
    # The first fragment starts with the encoder's B-frame delay (2 frames).
    assert fragments[0][0] < 0.1 and fragments[-1][1] == pytest.approx(60, abs=0.2)
    assert all(b[0] == pytest.approx(a[1]) for a, b in zip(fragments, fragments[1:]))


def whole_file(root: Path, tmp_path: Path) -> Path:
    """What a full yt-dlp download looks like: both tracks merged by ffmpeg."""
    whole = tmp_path / "whole.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(root / "video.mp4"), "-i", str(root / "audio.m4a"),
         "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", str(whole)],
        check=True, capture_output=True,
    )
    return whole


def test_section_downloads_only_the_part_on_the_source_clock(served, tmp_path):
    root, info = served
    work = tmp_path / "work"
    work.mkdir()
    section = tmp_path / "section.mkv"
    offset = _fast_download(info, (22.0, 31.0), work, section)
    assert offset == 0.0  # the part keeps the whole file's clock
    assert section.stat().st_size < (root / "video.mp4").stat().st_size / 2
    packets = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
         "-of", "csv=p=0", str(section)],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    times = sorted(float(t) for t in packets if t not in ("", "N/A"))
    assert times[0] < 1 and min(t for t in times if t > 10) <= 22.0 and times[-1] >= 31.0
    assert not any(10 < t < 19.9 for t in times)  # the minutes in between never came down


@pytest.mark.parametrize("keep", [[(24.0, 27.0)], [(26.0, 27.5), (21.0, 26.0)]])
def test_rendering_from_a_section_matches_the_whole_source(served, tmp_path, keep):
    from src.video_utils import create_optimized_clip

    root, info = served
    whole = whole_file(root, tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    section = tmp_path / "section.mkv"
    offset = _fast_download(info, (20.5, 28.0), work, section)
    start, end = min(a for a, _ in keep), max(b for _, b in keep)
    kwargs = dict(add_subtitles=False, output_format="original", keep_ranges=keep, extend_to_sentence=False)
    from_whole, from_section = tmp_path / "a.mp4", tmp_path / "b.mp4"
    assert create_optimized_clip(whole, start, end, from_whole, **kwargs)
    assert create_optimized_clip(whole, start, end, from_section, render_source=(section, offset), **kwargs)
    # Same picture and the same sound at the same moment, to the frame.
    assert first_flash(from_section) == pytest.approx(first_flash(from_whole), abs=0.02)
    assert first_beep(from_section) == pytest.approx(first_beep(from_whole), abs=0.02)


def test_sections_prefer_plain_https_files_over_hls_copies():
    from src.youtube_sections import section_format_selector

    first = section_format_selector().split("/")[0]
    # A finished live lists HLS copies yt-dlp ranks higher; the https mp4 comes first.
    assert "[protocol=https]" in first and "[ext=mp4]" in first


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_a_cut_with_no_picture_is_a_failure(tmp_path, monkeypatch):
    import src.youtube_sections as sections

    def ffmpeg_dropping_every_frame(args, timeout=900):
        # What ffmpeg did on a sliced VP9 HLS copy: audio only, exit code 0.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=2",
                        "-c:a", "aac", args[-1]], check=True)

    monkeypatch.setattr(sections, "_ffmpeg", ffmpeg_dropping_every_frame)
    info = {"requested_formats": [
        {"url": "https://example.test/v.m3u8", "vcodec": "vp09", "acodec": "none"},
        {"url": "https://example.test/a.m4a", "vcodec": "none", "acodec": "mp4a"},
    ]}
    with pytest.raises(sections.SectionDownloadError, match="no picture"):
        sections._exact_cut(info, (10.0, 20.0), tmp_path / "cut.mkv")
