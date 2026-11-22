"""The assembly show carries the real clip: cuts, timed words, webcam, preview."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from src.config import Config, set_config_override
from src.show import ShowReporter, read_show_state, show_dir, teaser_count

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.events = []

    async def setex(self, key, ttl, value):
        self.values[key] = value

    async def get(self, key):
        return self.values.get(key)

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)

    async def publish(self, channel, payload):
        self.events.append(json.loads(payload))


@pytest.fixture
def config(tmp_path):
    cfg = Config()
    cfg.temp_dir = str(tmp_path / "temp")
    set_config_override(cfg)
    yield cfg
    set_config_override(None)


@pytest.fixture
def source(tmp_path):
    # Blue game with a red webcam bottom-left; one word per second.
    path = tmp_path / "source.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=24:duration=12",
         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
         "-vf", "drawbox=x=0:y=220:w=120:h=100:color=red:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(path)],
        check=True, capture_output=True,
    )
    words = [{"text": f"palavra{i}.", "start": i * 1000, "end": i * 1000 + 600} for i in range(12)]
    path.with_suffix(".transcript_cache.json").write_text(json.dumps({"words": words}))
    return path


def test_teaser_count():
    assert teaser_count([(10, 12), (12, 12.5), (5, 20)]) == 2
    assert teaser_count([(5, 10), (11, 20)]) == 0


@pytest.mark.asyncio
async def test_a_render_publishes_its_real_assembly(config, source):
    from src.services.video_service import VideoService

    redis = FakeRedis()
    show = ShowReporter(redis, "task-show")
    segment = {"start_time": "00:01", "end_time": "00:09", "hook_title": "Que susto", "text": ""}
    await show.set_queue([{"n": 1, "status": "montando"}, {"n": 2, "status": "na fila"}])
    await show.start_clip(0, 2, segment, "vertical_gameplay")
    out = Path(config.temp_dir) / "clips"
    out.mkdir(parents=True)
    info = await VideoService.create_single_clip(
        source, segment, 0, out, None, None, None, "default", "vertical_gameplay", True, {},
        webcam_region={"x": 0.0, "y": 0.61, "w": 0.19, "h": 0.28}, hook_intro=False, show=show,
    )
    await asyncio.sleep(0.2)  # updates handed over from the render thread
    assert info and Path(info["path"]).exists()

    stages = [e["show"]["clip"]["stage"] for e in redis.events if e["show"].get("clip")]
    assert stages[0] == "momento"
    for stage in ("cortes", "enquadramento", "render"):
        assert stage in stages
    state = await read_show_state(redis, "task-show")
    clip = state["clip"]
    assert clip["title"] == "Que susto" and clip["layout"] == "vertical_gameplay"
    assert clip["ranges"] and clip["duration"] > 5
    assert clip["words"][0]["text"].startswith("palavra") and clip["words"][0]["start"] >= 0
    # The webcam found in the real cut, as fractions of its frame.
    assert clip["regions"]["cam"]["x"] < 0.05 and clip["regions"]["cam"]["y"] > 0.5
    # A light preview of the real cut and its filmstrip, served by the API.
    folder = show_dir("task-show") / clip["key"]
    assert (folder / "preview.mp4").exists() and (folder / "strip.jpg").exists()
    assert clip["preview"].startswith(f"/tasks/task-show/show/{clip['key']}/preview.mp4?v=")
    assert state["queue"][1]["status"] == "na fila"

    await show.finish()
    assert await read_show_state(redis, "task-show") == {"clip": None, "queue": []}
    assert not show_dir("task-show").exists()
