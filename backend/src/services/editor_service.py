"""Background preparation and rendering for the clip studio."""

from pathlib import Path
import asyncio
import json
import logging
import os
import subprocess
import uuid

from ..editor_document import (
    EditDocument,
    atomic_json,
    editor_dir,
    editor_lock,
    render_document,
)
from ..utils.async_helpers import run_in_thread
from ..media_storage import MediaStorage, STORAGE_ERRORS, media_work
from ..media.common import WEBCAM_OUTPUT_FORMATS


# One download per YouTube video at a time. Every download of a video writes
# the same "<video_id>.mp4", so concurrent clip preparations used to delete or
# overwrite each other's source mid-render.
_youtube_source_locks: dict[str, asyncio.Lock] = {}


async def _shared_youtube_source(video_service, url: str, temp_dir: str):
    """Reuse a finished download of this video, or download it once.

    The file is left in place for the other clips of the same video; the media
    sweep removes it after MEDIA_ORPHAN_GRACE_SECONDS like any other download.
    """
    from ..youtube_utils import get_youtube_video_id

    video_id = get_youtube_video_id(url)
    lock = _youtube_source_locks.setdefault(video_id or url, asyncio.Lock())
    async with lock:
        if video_id:
            # yt-dlp only writes this name once merging has finished.
            existing = Path(temp_dir) / f"{video_id}.mp4"
            if existing.is_file() and existing.stat().st_size > 0:
                os.utime(existing)  # keep the sweep from collecting it mid-edit
                return existing
        downloaded = await video_service.download_video(url)
        return Path(downloaded) if downloaded else None


def read_state(directory: Path):
    path = directory / "asset.json"
    if not path.exists():
        return {"status": "unprepared"}
    state = json.loads(path.read_text())
    if state.get("status") == "ready":
        state["draft"] = json.loads((directory / "draft.json").read_text())
        state["original"] = json.loads((directory / "original.json").read_text())
    return state


def make_assets(directory: Path):
    import numpy as np

    source = directory / "clean.mp4"
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    metadata = json.loads(probe.stdout)
    video = next(
        stream for stream in metadata["streams"] if stream["codec_type"] == "video"
    )
    numerator, denominator = video.get("avg_frame_rate", "30/1").split("/")
    fps = float(numerator) / max(1, float(denominator))
    duration = float(metadata["format"]["duration"])
    audio = any(stream["codec_type"] == "audio" for stream in metadata["streams"])
    waveform = []
    if audio:
        samples = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "f32le",
                "-",
            ],
            capture_output=True,
            check=True,
        )
        values = np.frombuffer(samples.stdout, dtype="float32")
        waveform = [
            round(float(np.max(np.abs(chunk))), 4) if len(chunk) else 0
            for chunk in np.array_split(values, 160)
        ]
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-vf",
            f"fps={12 / duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=12x1",
            "-frames:v",
            "1",
            str(directory / "thumbnails.jpg"),
        ],
        capture_output=True,
        check=True,
    )
    return {
        "status": "ready",
        "width": video["width"],
        "height": video["height"],
        "fps": fps or 30,
        "duration": duration,
        "hasAudio": audio,
        "waveform": waveform,
    }


def gameplay_framing(clip_path: Path, webcam_region=None, output_format: str = "vertical_gameplay"):
    """Editor framing that matches the generated gameplay clip, or None.

    Uses the same planner as the clip render (picked box, else detection), then
    expresses it in editor terms: the webcam box as fractions and the game cut
    as zoom/x/y, so the draft opens looking like the clip.
    """
    from ..media.reframing import detect_gameplay_plan
    from ..media.ffmpeg import ffprobe_video_size

    regions = detect_gameplay_plan(clip_path, webcam_region)
    if not regions:
        return None
    width, height = ffprobe_video_size(clip_path)
    cam, game = regions["cam"], regions["game"]
    x, y = max(0.0, cam["x"] / width), max(0.0, cam["y"] / height)
    floating = output_format == "vertical_cam_float"
    if floating:
        # The floating layout cuts the game at 9:16 around the same centre.
        cut_w = min(width, game["h"] * 9 / 16)
        centre = game["x"] + game["w"] / 2
        game = {**game, "w": cut_w, "x": max(0.0, min(width - cut_w, centre - cut_w / 2))}
    return {
        "layout": "float" if floating else "gameplay",
        "camPosition": "bottom" if output_format == "vertical_gameplay_bottom" else "top",
        "webcam": {
            "x": round(x, 4),
            "y": round(y, 4),
            "w": round(min(cam["w"] / width, 1 - x), 4),
            "h": round(min(cam["h"] / height, 1 - y), 4),
        },
        "zoom": round(max(1.0, min(3.0, height / max(1, game["h"]))), 4),
        "x": round(game["x"] / (width - game["w"]), 4) if width > game["w"] else 0.5,
        "y": round(game["y"] / (height - game["h"]), 4) if height > game["h"] else 0.5,
    }


async def prefetch_next_clip(task_id: str, clip_id: str, window: int):
    """Start preparing the first unprepared clip among the next ``window`` ones.

    Clips follow the list order. The prepared clip carries on with what is left
    of the window, so prefetching takes one worker slot at a time. Returns the
    clip id it started, or None.
    """
    if window <= 0:
        return None
    from ..config import get_config
    from ..database import AsyncSessionLocal
    from ..media_storage import is_s3
    from ..repositories.clip_repository import ClipRepository
    from ..workers.job_queue import JobQueue

    async with AsyncSessionLocal() as db:
        clips = await ClipRepository.get_clips_by_task(db, task_id)
    ids = [clip["id"] for clip in clips]
    if clip_id not in ids:
        return None
    start = ids.index(clip_id) + 1
    for step, clip in enumerate(clips[start : start + window], start=1):
        directory = editor_dir(get_config().temp_dir, task_id, clip["id"], clip["filename"])
        await run_in_thread(
            MediaStorage().restore_editor, directory, s3_backed=is_s3(clip.get("file_path") or "")
        )
        with editor_lock(directory):
            # Ready, already being prepared, or failed before: leave it.
            if read_state(directory)["status"] != "unprepared":
                continue
            atomic_json(directory / "asset.json", {"status": "preparing"})
        try:
            await JobQueue.enqueue_job(
                "prepare_editor", task_id, clip["id"], clip["filename"], prefetch=window - step
            )
        except Exception:
            # Opening the clip later prepares it the usual way.
            (directory / "asset.json").unlink(missing_ok=True)
            logging.getLogger(__name__).warning("Editor prefetch could not be queued", exc_info=True)
            return None
        return clip["id"]
    return None


@media_work
async def prepare_editor(ctx, task_id: str, clip_id: str, filename: str, prefetch: int = 0):
    from ..database import AsyncSessionLocal
    from .task_service import TaskService
    from ..config import get_config
    from ..video_utils import (
        create_optimized_clip,
        load_cached_transcript_data,
        get_words_for_keep_ranges,
    )
    from ..clip_editor import _caption_words_with_timings
    from ..clip_source_map import load_clip_caption_settings, source_range_bounds
    from .clip_source import ClipSource

    directory = editor_dir(get_config().temp_dir, task_id, clip_id, filename)
    storage = MediaStorage()
    shared_youtube_source = False
    source_url = None
    source = None
    clip_source = None
    render_source = None
    prepared = False
    try:
        await run_in_thread(storage.restore_editor, directory)
        async with AsyncSessionLocal() as db:
            service = TaskService(db)
            clip = await service.clip_repo.get_clip_by_id(db, clip_id)
            task = await service.task_repo.get_task_by_id(db, task_id)
            if (
                not task
                or not clip
                or clip["task_id"] != task_id
                or clip["filename"] != filename
            ):
                raise ValueError("O clipe original mudou. Abra o editor de novo.")
            ranges = await run_in_thread(service._get_clip_source_ranges, clip)
            source_url, source_type = task.get("source_url"), task.get("source_type")
            mode = task.get("processing_mode") or service.config.default_processing_mode
            cache = await service.cache_repo.get_cache(
                db, service._build_cache_key(source_url, source_type, mode)
            )
            source = (
                await run_in_thread(storage.local_path, cache["video_path"]) if cache and cache.get("video_path") else None
            )
            source_settings = await service._load_task_source_settings(task_id)
            caption_path = await run_in_thread(storage.local_path, clip["file_path"], metadata_only=True)
            caption_settings = load_clip_caption_settings(caption_path) or {}
            await db.close()
            if source_type == "live":
                # A live keeps only the minutes around each clip.
                from ..live.archive import LiveClipSource

                clip_source = LiveClipSource(task_id)
                render_source = await clip_source.render_source(*source_range_bounds(ranges))
                source = clip_source.timing_path
            elif not source or not source.exists():
                if source_type == "youtube" and get_config().youtube_partial_download:
                    # Only this clip's minutes, not the whole (maybe hours-long) video.
                    clip_source = await ClipSource.for_task(
                        service.video_service, source_url, source_type
                    )
                    bounds = source_range_bounds(ranges)
                    render_source = await clip_source.render_source(*bounds)
                    source = clip_source.timing_path
                elif source_type == "youtube":
                    source = await _shared_youtube_source(
                        service.video_service, source_url, get_config().temp_dir
                    )
                    shared_youtube_source = True
                else:
                    source = await run_in_thread(service.video_service.resolve_local_video_path, source_url)
            if not source or not (source.exists() or render_source):
                raise ValueError(
                    "O vídeo original não está disponível. Restaure o arquivo original para editar este clipe."
                )
            directory.mkdir(parents=True, exist_ok=True)
            clean = directory / "clean.mp4"
            rendered = await run_in_thread(
                create_optimized_clip,
                source,
                ranges[0][0],
                ranges[-1][1],
                clean,
                add_subtitles=False,
                output_format="original",
                keep_ranges=ranges,
                hook_title=None,
                extend_to_sentence=False,
                render_source=render_source,
            )
            if not rendered:
                raise ValueError("Não foi possível preparar o vídeo original")
            output_format = source_settings.get("output_format")

            async def framing():
                if output_format not in WEBCAM_OUTPUT_FORMATS:
                    return None
                try:
                    return await run_in_thread(
                        gameplay_framing, clean, source_settings.get("webcam_region"), output_format
                    )
                except Exception:
                    logging.getLogger(__name__).warning(
                        "Gameplay framing for the editor failed", exc_info=True
                    )
                    return None

            # Both only read clean.mp4: thumbnails/waveform and the webcam search at once.
            metadata, gameplay = await asyncio.gather(run_in_thread(make_assets, directory), framing())
            # Offered again when the user switches the draft to webcam + game.
            metadata["gameplay"] = gameplay
            transcript = load_cached_transcript_data(source)
            timed = get_words_for_keep_ranges(transcript, ranges) if transcript else []
            words = _caption_words_with_timings(
                (clip.get("text") or "").split(), timed, metadata["duration"]
            )
            duration = metadata["duration"]
            initial = (
                EditDocument.model_validate(
                    {
                        "segments": [{"id": "original", "start": 0, "end": duration}],
                        "framing": {
                            "aspect": "original"
                            if source_settings.get("output_format") == "original"
                            else "vertical",
                            **(
                                {"fit": "contain", "background": "blur"}
                                if output_format == "vertical_blur"
                                else {}
                            ),
                            **(gameplay or {}),
                        },
                        "captions": {
                            "enabled": source_settings.get("add_subtitles", True),
                            "font": task.get("font_family")
                            if task.get("font_family")
                            in {
                                "TikTokSans-Regular",
                                "Poppins-ExtraBold",
                                "THEBOLDFONT",
                            }
                            else "TikTokSans-Regular",
                            "color": task.get("font_color") or "#FFFFFF",
                            "y": max(
                                0.1,
                                min(0.9, caption_settings.get("position_y") or 0.78),
                            ),
                        },
                        "words": [
                            {
                                "id": f"word-{i}",
                                "start": max(0, min(w["start"], duration - 0.01)),
                                "end": max(0.01, min(w["end"], duration)),
                                "text": w["text"][:120],
                            }
                            for i, w in enumerate(words)
                            if w["start"] < duration and w["end"] > 0
                        ],
                    }
                )
                .validate_duration(duration)
                .model_dump()
            )
            with editor_lock(directory):
                if not (directory / "draft.json").exists():
                    atomic_json(
                        directory / "draft.json", {"revision": 0, "document": initial}
                    )
                    atomic_json(directory / "original.json", initial)
                atomic_json(directory / "asset.json", metadata)
            prepared = True
    except Exception:
        logging.getLogger(__name__).exception("Editor preparation failed")
        from ..youtube_utils import YOUTUBE_BOT_CHECK_MESSAGE, youtube_blocked_by_bot_check

        error = (
            YOUTUBE_BOT_CHECK_MESSAGE
            if source_url and youtube_blocked_by_bot_check(source_url)
            else "Não foi possível preparar o vídeo original. Confira se ele está disponível e tente de novo."
        )
        atomic_json(directory / "asset.json", {"status": "failed", "error": error})
    finally:
        if clip_source is not None:
            clip_source.release(render_source)
            # A whole-video fallback stays for this video's other clips; the
            # media sweep removes it like any other download.
            clip_source.close(delete_full=False)
        elif shared_youtube_source:
            pass  # other clips of this video reuse it; the media sweep removes it
        elif source is not None:
            await run_in_thread(storage.save_source_metadata, source)
        await run_in_thread(storage.save_editor, directory)
    if prepared and prefetch > 0:
        try:
            await prefetch_next_clip(task_id, clip_id, prefetch)
        except Exception:
            logging.getLogger(__name__).warning("Editor prefetch failed", exc_info=True)


@media_work
async def export_editor(ctx, task_id: str, clip_id: str, filename: str, job_id: str):
    from ..config import get_config
    from ..database import AsyncSessionLocal
    from .task_service import TaskService

    directory = editor_dir(get_config().temp_dir, task_id, clip_id, filename)
    try:
        await run_in_thread(MediaStorage().restore_editor, directory, media=True)
        async with AsyncSessionLocal() as db:
            service = TaskService(db)
            clip = await service.clip_repo.get_clip_by_id(db, clip_id)
            if not clip or clip["task_id"] != task_id:
                raise ValueError("O clipe não existe mais")
        payload = json.loads((directory / f"request-{job_id}.json").read_text())
        if (directory / f"cancel-{job_id}").exists():
            raise InterruptedError()
        document = EditDocument.model_validate(payload["document"])
        await run_in_thread(
            render_document, directory, job_id, document, payload["preset"]
        )
        await run_in_thread(MediaStorage().persist_editor_export, directory, job_id)
        atomic_json(
            directory / f"job-{job_id}.json", {"status": "completed", "progress": 100}
        )
    except InterruptedError:
        atomic_json(
            directory / f"job-{job_id}.json", {"status": "cancelled", "progress": 0}
        )
    except Exception:
        logging.getLogger(__name__).exception("Editor export failed")
        atomic_json(
            directory / f"job-{job_id}.json",
            {
                "status": "failed",
                "error": "Export failed. Your draft is safe; retry the export.",
                "progress": 0,
            },
        )
    finally:
        await run_in_thread(MediaStorage().save_editor, directory)


@media_work
async def combine_editor(ctx, task_id: str, clip_id: str, filename: str, job_id: str):
    """Create a new clip from draft cuts, keeping every input clip and its draft."""
    import shutil
    import tempfile
    from ..config import get_config
    from ..database import AsyncSessionLocal
    from ..repositories.edit_transaction import task_edit_transaction
    from ..clip_source_map import save_clip_source_ranges, slice_source_ranges
    from ..editor_document import mapped_words, run_render
    from .task_service import TaskService

    directory = editor_dir(get_config().temp_dir, task_id, clip_id, filename)
    storage = MediaStorage()
    committed = False
    destination = None
    clip_path = None
    reference = None
    try:
        await run_in_thread(MediaStorage().restore_editor, directory)
        payload = json.loads((directory / f"request-{job_id}.json").read_text())
        entries = payload["inputs"]
        commands, filters, joins, all_words, ranges = ["ffmpeg", "-y"], [], [], [], []
        cursor = 0.0
        width, height = entries[0]["state"]["width"], entries[0]["state"]["height"]
        scale = min(1, 1920 / max(width, height))
        width, height = int(width * scale) // 2 * 2, int(height * scale) // 2 * 2
        # Keep the fastest input's frame rate (clips follow their source, 24-60 fps).
        fps = max(round(float(entry["state"].get("fps") or 30)) for entry in entries)
        fps = max(min(24, get_config().max_output_fps), min(get_config().max_output_fps, fps))
        for i, entry in enumerate(entries):
            source_dir = editor_dir(
                get_config().temp_dir, task_id, entry["id"], entry["filename"]
            )
            await run_in_thread(MediaStorage().restore_editor, source_dir, media=True)
            commands += ["-i", str(source_dir / "clean.mp4")]
            document = EditDocument.model_validate(entry["document"])
            all_words += [
                {
                    **w,
                    "id": uuid.uuid4().hex,
                    "start": w["start"] + cursor,
                    "end": w["end"] + cursor,
                }
                for w in mapped_words(document)
            ]
            for j, segment in enumerate(document.segments):
                key = f"{i}_{j}"
                filters.append(
                    f"[{i}:v]trim=start={segment.start}:end={segment.end},setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}[v{key}]"
                )
                if entry["state"]["hasAudio"]:
                    filters.append(
                        f"[{i}:a]atrim=start={segment.start}:end={segment.end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a{key}]"
                    )
                else:
                    filters.append(
                        f"anullsrc=r=48000:cl=stereo,atrim=duration={segment.end - segment.start}[a{key}]"
                    )
                joins += [f"[v{key}][a{key}]"]
                cursor += segment.end - segment.start
                ranges += slice_source_ranges(
                    entry["ranges"], segment.start, segment.end
                )
        filters.append("".join(joins) + f"concat=n={len(joins)}:v=1:a=1[v][a]")
        initial = {
            **entries[0]["document"],
            "segments": [{"id": "combined", "start": 0, "end": cursor}],
            "words": all_words,
        }
        document = EditDocument.model_validate(initial).validate_duration(cursor)
        with tempfile.TemporaryDirectory(prefix="combine_", dir=directory) as temp:
            work = Path(temp)
            # Cancellation/progress files share the parent job for both render passes.
            commands += [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(work / "clean.mp4"),
            ]
            await run_in_thread(run_render, commands, directory, job_id, cursor)
            if (directory / f"cancel-{job_id}").exists():
                raise InterruptedError()
            # A symlink allows the second rendering pass to observe cancellation.
            (work / f"cancel-{job_id}").symlink_to(directory / f"cancel-{job_id}")
            await run_in_thread(render_document, work, job_id, document, "tiktok")
            new_filename = f"combined_{uuid.uuid4().hex}.mp4"
            clip_path = Path(get_config().temp_dir) / "clips" / new_filename
            clip_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(work / f"export-{job_id}.mp4", clip_path)
            save_clip_source_ranges(clip_path, ranges)
            metadata = await run_in_thread(make_assets, work)
            # Finish durable export delivery before committing the new clip.
            # Cleanup may reclaim clip_path immediately after that commit.
            shutil.copy2(work / f"export-{job_id}.mp4", directory / f"export-{job_id}.mp4")
            await run_in_thread(MediaStorage().persist_editor_export, directory, job_id)
            reference = await run_in_thread(storage.persist_clip, str(clip_path), task_id)
            new_id = str(uuid.uuid4())
            destination = editor_dir(get_config().temp_dir, task_id, new_id, new_filename)
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copy2(work / "clean.mp4", destination / "clean.mp4")
            shutil.copy2(work / "thumbnails.jpg", destination / "thumbnails.jpg")
            atomic_json(destination / "draft.json", {"revision": 0, "document": document.model_dump()})
            atomic_json(destination / "original.json", document.model_dump())
            atomic_json(destination / "asset.json", metadata)
            await run_in_thread(storage.save_editor, destination)
            async with AsyncSessionLocal() as db:
                service = TaskService(db)
                async with task_edit_transaction(db, task_id):
                    clips = await service.clip_repo.get_clips_by_task(db, task_id)
                    if not all(
                        any(
                            c["id"] == entry["id"]
                            and c["filename"] == entry["filename"]
                            for c in clips
                        )
                        for entry in entries
                    ):
                        raise ValueError("Um dos clipes mudou durante a combinação")
                    new_id = await service.clip_repo.create_clip(
                        db,
                        task_id,
                        new_filename,
                        reference,
                        "00:00",
                        service._seconds_to_mmss(cursor),
                        cursor,
                        " ".join(w["text"] for w in all_words),
                        0,
                        "Combined in the clip editor",
                        max(c["clip_order"] for c in clips) + 1,
                        clip_id=new_id,
                    )
                    if reference != str(clip_path):
                        from ..repositories.media_repository import queue_delete
                        await queue_delete(db, str(clip_path))
                    await service.clip_repo.reorder_task_clips(db, task_id)
                committed = True
        atomic_json(
            directory / f"job-{job_id}.json",
            {"status": "completed", "progress": 100, "clip_id": new_id},
        )
    except InterruptedError:
        atomic_json(
            directory / f"job-{job_id}.json", {"status": "cancelled", "progress": 0}
        )
    except Exception:
        logging.getLogger(__name__).exception("Combining editor drafts failed")
        atomic_json(
            directory / f"job-{job_id}.json",
            {
                "status": "failed",
                "progress": 0,
                "error": "Could not combine drafts. The original clips are unchanged.",
            },
        )
    finally:
        if not committed:
            # Queue exact staged objects. A fresh DB reference check protects
            # against a commit that succeeded before its response was lost.
            from ..repositories.media_repository import queue_delete
            async with AsyncSessionLocal() as db:
                for path, prefix in [(str(directory / f"export-{job_id}.mp4"), False),
                                     (storage.editor_reference(directory, f"export-{job_id}.mp4"), False) if storage.enabled else (None, False),
                                     (reference, False),
                                     (str(clip_path) if clip_path else None, False),
                                     (str(destination) if destination else None, True),
                                     (storage.editor_reference(destination) if storage.enabled and destination else None, True)]:
                    if path:
                        await queue_delete(db, path, prefix=prefix)
                await db.commit()
        try:
            await run_in_thread(storage.save_editor, directory)
        except STORAGE_ERRORS:
            logging.getLogger(__name__).warning("Editor job snapshot retained for upload retry")
