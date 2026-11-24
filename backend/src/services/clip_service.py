"""Clip editing and regeneration operations shared by TaskService.

The mixin uses TaskService's repositories, configuration, and cache key contract.
"""

from ..repositories import edit_transaction
from ..repositories.edit_transaction import serialized_task_edit
from typing import Dict, Any, Optional
import logging
from pathlib import Path
import json
import tempfile

import redis.asyncio as redis

from ..clip_editor import (
    trim_clip_file,
    split_clip_file,
    merge_clip_files,
    overlay_custom_captions,
)
from ..video_utils import VALID_OUTPUT_FORMATS, parse_timestamp_to_seconds, create_optimized_clip
from ..utils.async_helpers import run_in_thread
from ..clip_cleanup import normalize_clip_cleanup_settings
from ..media.common import normalize_webcam_region
from ..ai import normalize_clip_count
from ..clip_source_map import (
    load_clip_source_ranges,
    save_clip_source_ranges,
    save_clip_caption_settings,
    load_clip_caption_settings,
    source_range_bounds,
    split_source_ranges,
    total_source_duration,
    trim_source_ranges,
)

from ..media_storage import MediaStorage

logger = logging.getLogger(__name__)

REGENERATION_MESSAGE = "Refazendo os clipes com as novas configurações…"


class ClipEditingMixin:
    @serialized_task_edit
    async def delete_clip(self, task_id: str, clip_id: str) -> None:
        clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if not clip or clip["task_id"] != task_id:
            raise ValueError("Clipe não encontrado")
        await self.clip_repo.delete_clip(self.db, clip_id)
        await self.clip_repo.reorder_task_clips(self.db, task_id)

    @serialized_task_edit
    async def update_task_settings(
        self,
        task_id: str,
        font_family: Optional[str],
        font_size: Optional[int],
        font_color: Optional[str],
        caption_template: str,
        include_broll: bool,
        apply_to_existing: bool = False,
        cleanup_settings: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Save the task's styling. Remaking the clips with it is a worker job
        (``start_clip_regeneration``): it takes minutes on a long video."""
        await self.task_repo.update_task_settings(
            self.db,
            task_id,
            font_family,
            font_size,
            font_color,
            caption_template,
            include_broll,
        )
        return await self.get_task_with_clips(task_id) or {}

    async def regenerate_all_clips_for_task(
        self,
        task_id: str,
        font_family: Optional[str],
        font_size: Optional[int],
        font_color: Optional[str],
        caption_template: str,
        cleanup_settings: Optional[Dict[str, Any]] = None,
        progress_callback=None,
        recompute_cleanup: Optional[bool] = None,
    ) -> Dict[str, int]:
        """Render every clip of a task again with new settings, one clip at a time.

        Runs in the worker while the task is "processing" (other edits wait for
        it to end). Each clip keeps its id, moment and title; only its picture is
        made again, from a section of the source like the editor does. The task
        row is locked just while each new clip is saved, never across a render:
        a long video takes many minutes and the database drops a transaction
        left open for 5. Stops when the task is cancelled.
        Returns ``{"done": n, "failed": n}``.
        """
        from ..clip_review import segment_from_clip

        task = await self.task_repo.get_task_by_id(self.db, task_id)
        if not task:
            raise ValueError("Tarefa não encontrada")

        metadata = await self._load_task_source_settings(task_id)
        cleanup_payload = cleanup_settings or {
            "cut_long_pauses": metadata.get("cut_long_pauses"),
            "pause_threshold_ms": metadata.get("pause_threshold_ms"),
            "remove_filler_words": metadata.get("remove_filler_words"),
            "filtered_words": metadata.get("filtered_words"),
        }
        normalized_cleanup_settings = normalize_clip_cleanup_settings(
            cleanup_payload.get("cut_long_pauses"),
            cleanup_payload.get("pause_threshold_ms"),
            cleanup_payload.get("remove_filler_words"),
            cleanup_payload.get("filtered_words"),
        )
        existing_cleanup_settings = normalize_clip_cleanup_settings(
            metadata.get("cut_long_pauses"),
            metadata.get("pause_threshold_ms"),
            metadata.get("remove_filler_words"),
            metadata.get("filtered_words"),
        )
        # The route saves the new cleanup settings before the job runs, so it
        # tells the job whether they changed.
        should_recompute_cleanup = (
            recompute_cleanup
            if recompute_cleanup is not None
            else cleanup_settings is not None and normalized_cleanup_settings != existing_cleanup_settings
        )

        clips = await self.clip_repo.get_clips_by_task(self.db, task_id)
        if not clips:
            return {"done": 0, "failed": 0}
        # Close the reading transaction before the long work.
        if self.db is not None:
            await self.db.commit()

        clip_source = await self._clip_source_for_task(task)
        output_dir = Path(self.config.temp_dir) / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        done = failed = 0
        try:
            for index, clip in enumerate(clips):
                if progress_callback:
                    await progress_callback(index, len(clips))
                ranges = await run_in_thread(self._get_clip_source_ranges, clip)
                segment = segment_from_clip(clip, ranges)
                if should_recompute_cleanup:
                    segment["source_ranges"] = ranges
                else:
                    segment["keep_ranges"] = ranges
                info = await self.video_service.create_single_clip(
                    clip_source.timing_path,
                    segment,
                    max(0, int(clip.get("clip_order") or index + 1) - 1),
                    output_dir,
                    font_family,
                    font_size,
                    font_color,
                    caption_template,
                    metadata.get("output_format", "vertical"),
                    metadata.get("add_subtitles", True),
                    normalized_cleanup_settings,
                    webcam_region=metadata.get("webcam_region"),
                    hook_intro=metadata.get("hook_intro"),
                    clip_source=clip_source,
                    watermark=bool(metadata.get("watermark")),
                    title_overlay=metadata.get("title_overlay") is not False,
                )
                if not info:
                    failed += 1
                    logger.warning("Regenerating clip %s of task %s failed; it keeps its old version", clip["id"], task_id)
                    continue
                async with edit_transaction.task_edit_transaction(self.db, task_id, processing=True):
                    await self.clip_repo.update_clip(
                        self.db, clip["id"], info["filename"], info["path"], info["start_time"],
                        info["end_time"], info["duration"], info.get("text") or clip.get("text") or "",
                    )
                from ..desktop import export_clip

                await export_clip(
                    task_id, info["path"], int(clip.get("clip_order") or index + 1), clip.get("hook_title")
                )
                done += 1
        finally:
            await run_in_thread(clip_source.close)
        return {"done": done, "failed": failed}


    @serialized_task_edit
    async def start_clip_regeneration(self, task_id: str, settings: Dict[str, Any]) -> bool:
        """Mark the task "processing" and queue the job that remakes its clips.

        False when the task has no clips (nothing to remake).
        """
        from ..workers.job_queue import JobQueue

        task = await self.task_repo.get_task_by_id(self.db, task_id)
        if not task or not await self.clip_repo.get_clips_by_task(self.db, task_id):
            return False
        await self.task_repo.update_task_status(
            self.db, task_id, "processing", progress=0, progress_message=REGENERATION_MESSAGE
        )
        # Inside the edit: if queueing fails, the status change rolls back with it.
        await JobQueue.enqueue_job("regenerate_task_clips", task_id, task.get("status") or "completed", settings)
        return True


    @serialized_task_edit
    async def trim_clip(
        self,
        task_id: str,
        clip_id: str,
        start_offset: float,
        end_offset: float,
    ) -> Dict[str, Any]:
        clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if not clip or clip["task_id"] != task_id:
            raise ValueError("Clipe não encontrado")

        input_path = await run_in_thread(MediaStorage().local_path, clip["file_path"])
        if not input_path.exists():
            raise ValueError("Arquivo do clipe não encontrado")

        output_path = await run_in_thread(
            trim_clip_file, input_path, Path(self.config.temp_dir) / "clips", start_offset, end_offset
        )
        source_ranges = await run_in_thread(self._get_clip_source_ranges, clip)
        trimmed_ranges = trim_source_ranges(source_ranges, start_offset, end_offset)
        clip_duration = max(0.1, total_source_duration(trimmed_ranges))
        bounds = source_range_bounds(trimmed_ranges)
        if not bounds:
            raise ValueError("O clipe cortado ficou sem mapeamento de origem")
        start_seconds, end_seconds = bounds
        save_clip_source_ranges(output_path, trimmed_ranges)
        if settings := load_clip_caption_settings(input_path):
            save_clip_caption_settings(output_path, settings)

        new_start = self._seconds_to_mmss(start_seconds)
        new_end = self._seconds_to_mmss(end_seconds)

        await self.clip_repo.update_clip(
            self.db,
            clip_id,
            output_path.name,
            str(output_path),
            new_start,
            new_end,
            clip_duration,
            clip.get("text") or "",
        )
        return (await self.clip_repo.get_clip_by_id(self.db, clip_id)) or {}


    @serialized_task_edit
    async def split_clip(
        self, task_id: str, clip_id: str, split_time: float
    ) -> Dict[str, Any]:
        clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if not clip or clip["task_id"] != task_id:
            raise ValueError("Clipe não encontrado")

        input_path = await run_in_thread(MediaStorage().local_path, clip["file_path"])
        if not input_path.exists():
            raise ValueError("Arquivo do clipe não encontrado")

        first_path, second_path = await run_in_thread(
            split_clip_file, input_path, Path(self.config.temp_dir) / "clips", split_time
        )

        clamped_split = max(0.2, min(split_time, float(clip["duration"]) - 0.2))
        source_ranges = await run_in_thread(self._get_clip_source_ranges, clip)
        first_ranges, second_ranges = split_source_ranges(source_ranges, clamped_split)
        first_bounds = source_range_bounds(first_ranges)
        second_bounds = source_range_bounds(second_ranges)
        if not first_bounds or not second_bounds:
            raise ValueError("O clipe dividido tem um mapeamento de origem inválido")
        save_clip_source_ranges(first_path, first_ranges)
        save_clip_source_ranges(second_path, second_ranges)
        if settings := load_clip_caption_settings(input_path):
            save_clip_caption_settings(first_path, settings)
            save_clip_caption_settings(second_path, settings)
        first_duration = max(0.1, total_source_duration(first_ranges))
        second_duration = max(0.1, total_source_duration(second_ranges))

        await self.clip_repo.update_clip(
            self.db,
            clip_id,
            first_path.name,
            str(first_path),
            self._seconds_to_mmss(first_bounds[0]),
            self._seconds_to_mmss(first_bounds[1]),
            first_duration,
            clip.get("text") or "",
        )

        await self.clip_repo.make_room_for_clip(
            self.db, task_id, clip.get("clip_order", 1) + 1
        )
        await self.clip_repo.create_clip(
            self.db,
            task_id=task_id,
            filename=second_path.name,
            file_path=str(second_path),
            start_time=self._seconds_to_mmss(second_bounds[0]),
            end_time=self._seconds_to_mmss(second_bounds[1]),
            duration=second_duration,
            text=clip.get("text") or "",
            relevance_score=clip.get("relevance_score", 0.5),
            reasoning=clip.get("reasoning") or "Split from original clip",
            clip_order=clip.get("clip_order", 1) + 1,
            virality_score=clip.get("virality_score", 0),
            hook_score=clip.get("hook_score", 0),
            engagement_score=clip.get("engagement_score", 0),
            value_score=clip.get("value_score", 0),
            shareability_score=clip.get("shareability_score", 0),
            hook_type=clip.get("hook_type"),
            hook_title=clip.get("hook_title"),
        )

        await self.clip_repo.reorder_task_clips(self.db, task_id)
        return {"message": "Clipe dividido"}


    @serialized_task_edit
    async def merge_clips(self, task_id: str, clip_ids: list[str]) -> Dict[str, Any]:
        if len(clip_ids) < 2 or len(set(clip_ids)) != len(clip_ids):
            raise ValueError("São necessários pelo menos dois clipes diferentes para juntar")

        clips = []
        for clip_id in clip_ids:
            clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
            if not clip or clip["task_id"] != task_id:
                raise ValueError("Um ou mais clipes não foram encontrados")
            clips.append(clip)

        ordered = sorted(clips, key=lambda c: c.get("clip_order", 0))
        input_paths = [await run_in_thread(MediaStorage().local_path, c["file_path"]) for c in ordered]
        merged_path = await run_in_thread(
            merge_clip_files,
            input_paths,
            Path(self.config.temp_dir) / "clips",
        )

        merged_ranges = []
        for clip in ordered:
            merged_ranges.extend(await run_in_thread(self._get_clip_source_ranges, clip))
        merged_bounds = source_range_bounds(merged_ranges)
        if merged_bounds:
            start_time = self._seconds_to_mmss(merged_bounds[0])
            end_time = self._seconds_to_mmss(merged_bounds[1])
            duration = total_source_duration(merged_ranges)
            save_clip_source_ranges(merged_path, merged_ranges)
        else:
            start_time = ordered[0]["start_time"]
            end_time = ordered[-1]["end_time"]
            duration = sum(float(c.get("duration", 0.0)) for c in ordered)
        text = " ".join((c.get("text") or "").strip() for c in ordered if c.get("text"))

        first = ordered[0]
        await self.clip_repo.update_clip(
            self.db,
            first["id"],
            merged_path.name,
            str(merged_path),
            start_time,
            end_time,
            duration,
            text,
        )

        for clip in ordered[1:]:
            await self.clip_repo.delete_clip(self.db, clip["id"])

        await self.clip_repo.reorder_task_clips(self.db, task_id)
        return {"message": "Clipes juntados", "clip_id": first["id"]}


    @serialized_task_edit
    async def update_clip_captions(
        self,
        task_id: str,
        clip_id: str,
        caption_text: str,
        position: str,
        highlight_words: list[str],
        *,
        font_size: Optional[int] = None,
        position_y: Optional[float] = None,
    ) -> Dict[str, Any]:
        clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if not clip or clip["task_id"] != task_id:
            raise ValueError("Clipe não encontrado")

        input_path = await run_in_thread(MediaStorage().local_path, clip["file_path"])
        if not input_path.exists():
            raise ValueError("Arquivo do clipe não encontrado")

        task = await self.task_repo.get_task_by_id(self.db, task_id)
        if not task:
            raise ValueError("Tarefa não encontrada")

        # Always render from the source; overlaying an already captioned clip
        # stacks old and new captions and compounds quality loss on every save.
        # A YouTube source brings down only this clip's minutes.
        source_ranges = await run_in_thread(self._get_clip_source_ranges, clip)
        bounds = source_range_bounds(source_ranges)
        if not bounds:
            raise ValueError("O tempo de origem do clipe não está disponível")
        clip_source = await self._clip_source_for_task(task)
        render_source = None
        try:
            render_source = await clip_source.render_source(*bounds)
            transcript_video_path = clip_source.timing_path
            settings = await self._load_task_source_settings(task_id)
            output_dir = Path(self.config.temp_dir) / "clips"
            output_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="caption_edit_", dir=output_dir) as temporary:
                clean_path = Path(temporary) / "clean.mp4"
                rendered = await run_in_thread(
                    create_optimized_clip, transcript_video_path, bounds[0], bounds[1], clean_path,
                    add_subtitles=False,
                    output_format=settings.get("output_format", "vertical"),
                    keep_ranges=source_ranges,
                    hook_title=clip.get("hook_title"),
                    font_family=task.get("font_family") or None,
                    font_size=task.get("font_size") or None,
                    font_color=task.get("font_color") or None,
                    caption_template=task.get("caption_template") or "default",
                    extend_to_sentence=False,
                    webcam_region=settings.get("webcam_region"),
                    hook_rewind=settings.get("hook_intro") is True,
                    render_source=render_source,
                )
                if not rendered:
                    raise ValueError("Não foi possível preparar o clipe para editar as legendas")
                output_path = await run_in_thread(
                    overlay_custom_captions,
                    clean_path, output_dir, caption_text, position, highlight_words,
                    font_family=task.get("font_family") or None,
                    font_size=font_size if font_size is not None else task.get("font_size") or None,
                    font_color=task.get("font_color") or None,
                    caption_template=task.get("caption_template") or "default",
                    transcript_video_path=transcript_video_path,
                    source_ranges=source_ranges,
                    position_y=position_y,
                )
        finally:
            clip_source.release(render_source)
            await run_in_thread(clip_source.close)
        save_clip_source_ranges(output_path, source_ranges)
        save_clip_caption_settings(output_path, {
            "font_size": font_size if font_size is not None else task.get("font_size"),
            "position": position,
            "position_y": position_y if position_y is not None else {"top": 0.18, "middle": 0.52, "bottom": 0.78}[position],
            "highlight_words": highlight_words,
        })

        await self.clip_repo.update_clip(
            self.db,
            clip_id,
            output_path.name,
            str(output_path),
            clip["start_time"],
            clip["end_time"],
            clip["duration"],
            caption_text,
        )
        return (await self.clip_repo.get_clip_by_id(self.db, clip_id)) or {}


    @serialized_task_edit
    async def adjust_clip_with_text(
        self, task_id: str, clip_id: str, instructions: str
    ) -> Dict[str, Any]:
        """Change a ready clip from a plain request ("começa 3 s antes",
        "troca a headline") and render it again from the source."""
        from ..ai import adjust_clip
        from ..clip_review import (
            apply_adjustment,
            build_adjust_prompt,
            fit_to_window,
            segment_bounds,
            segment_from_clip,
        )
        from ..media.voice_energy import energy_zscores, measure_voice_energy

        instructions = (instructions or "").strip()
        if not instructions:
            raise ValueError("Escreva o que mudar no clipe")
        clip = await self.clip_repo.get_clip_by_id(self.db, clip_id)
        if not clip or clip["task_id"] != task_id:
            raise ValueError("Clipe não encontrado")
        task = await self.task_repo.get_task_by_id(self.db, task_id)
        if not task:
            raise ValueError("Tarefa não encontrada")

        ranges = await run_in_thread(self._get_clip_source_ranges, clip)
        segment = segment_from_clip(clip, ranges)
        settings = await self._load_task_source_settings(task_id)
        clip_source = await self._clip_source_for_task(task)
        try:
            timing_path = clip_source.timing_path
            # A live keeps only the minutes around each clip: the edit must stay inside them.
            window_of = getattr(clip_source, "window", None)
            window = window_of(*segment_bounds(segment)) if window_of else None
            levels = await run_in_thread(measure_voice_energy, timing_path)
            prompt = build_adjust_prompt(
                timing_path,
                segment,
                instructions,
                voice_energy=energy_zscores(levels) if levels else None,
                window=window,
            )
            try:
                adjustment = await adjust_clip(prompt)
            except Exception as exc:
                logger.warning("Clip adjustment request failed: %s", type(exc).__name__)
                raise ValueError("A IA não respondeu agora. Tente de novo em instantes.") from exc
            adjusted = apply_adjustment(segment, adjustment)
            window_note = fit_to_window(adjusted, window)
            output_dir = Path(self.config.temp_dir) / "clips"
            output_dir.mkdir(parents=True, exist_ok=True)
            info = await self.video_service.create_single_clip(
                clip_source.timing_path,
                adjusted,
                max(0, int(clip.get("clip_order") or 1) - 1),
                output_dir,
                task.get("font_family") or None,
                task.get("font_size") or None,
                task.get("font_color") or None,
                task.get("caption_template") or "default",
                settings.get("output_format", "vertical"),
                settings.get("add_subtitles", True),
                normalize_clip_cleanup_settings(
                    settings.get("cut_long_pauses"),
                    settings.get("pause_threshold_ms"),
                    settings.get("remove_filler_words"),
                    settings.get("filtered_words"),
                ),
                webcam_region=settings.get("webcam_region"),
                hook_intro=settings.get("hook_intro"),
                clip_source=clip_source,
                watermark=bool(settings.get("watermark")),
                title_overlay=settings.get("title_overlay") is not False,
            )
        finally:
            await run_in_thread(clip_source.close)
        if not info:
            raise ValueError("Não foi possível montar o clipe de novo. Tente outra vez.")

        await self.clip_repo.update_clip(
            self.db,
            clip_id,
            info["filename"],
            info["path"],
            info["start_time"],
            info["end_time"],
            info["duration"],
            info.get("text") or "",
        )
        if adjusted.get("hook_title") != clip.get("hook_title"):
            await self.clip_repo.update_clip_hook_title(self.db, clip_id, adjusted.get("hook_title"))
        from ..desktop import export_clip

        await export_clip(
            task_id, info["path"], int(clip.get("clip_order") or 1), adjusted.get("hook_title") or clip.get("hook_title")
        )
        return {
            "clip": (await self.clip_repo.get_clip_by_id(self.db, clip_id)) or {},
            "reply": " ".join(
                part for part in (
                    (adjustment.reply or "").strip()[:300] or "Pronto, o clipe foi refeito.",
                    window_note,
                ) if part
            ),
        }

    async def _clip_source_for_task(self, task: Dict[str, Any]) -> "ClipSource":
        """Where a finished task's clips take their picture from when re-rendered."""
        from .clip_source import ClipSource

        source_url = task.get("source_url")
        source_type = task.get("source_type")
        if source_type == "live":
            from ..live.archive import LiveClipSource

            return LiveClipSource(task["id"])
        if not source_url or not source_type:
            raise ValueError("O link de origem da tarefa está ausente")
        processing_mode = task.get("processing_mode") or self.config.default_processing_mode
        cache_entry = await self.cache_repo.get_cache(
            self.db, self._build_cache_key(source_url, source_type, processing_mode)
        )
        try:
            return await ClipSource.for_task(
                self.video_service,
                source_url,
                source_type,
                cache_entry.get("video_path") if cache_entry else None,
            )
        except ValueError as exc:
            raise ValueError(
                "O vídeo original não está mais disponível. Envie de novo para editar este clipe."
            ) from exc

    @staticmethod
    def _seconds_to_mmss(seconds: float) -> str:
        total = max(0, int(round(seconds)))
        minutes = total // 60
        secs = total % 60
        return f"{minutes:02d}:{secs:02d}"


    @staticmethod
    def _get_clip_source_ranges(clip: Dict[str, Any]) -> list[tuple[float, float]]:
        file_path = clip.get("file_path")
        if isinstance(file_path, str) and file_path:
            persisted = load_clip_source_ranges(MediaStorage().local_path(file_path, metadata_only=True))
            if persisted:
                return persisted

        start_seconds = parse_timestamp_to_seconds(clip["start_time"])
        end_seconds = parse_timestamp_to_seconds(clip["end_time"])
        return [(start_seconds, end_seconds)]


    async def _load_task_source_settings(self, task_id: str) -> Dict[str, Any]:
        defaults = {
            "output_format": "vertical",
            "add_subtitles": True,
            **normalize_clip_cleanup_settings(),
        }
        parsed = (
            await self.task_repo.load_source_metadata(self.db, task_id)
            if self.db is not None else {}
        )
        if not parsed:
            redis_client = redis.Redis(
                host=self.config.redis_host,
                port=self.config.redis_port,
                password=self.config.redis_password,
                decode_responses=True,
            )
            try:
                payload = await redis_client.get(f"task_source:{task_id}")
            except Exception as exc:
                logger.warning(
                    "Falling back to default task source settings for task %s: %s",
                    task_id, exc,
                )
                return defaults
            finally:
                try:
                    await redis_client.aclose()
                except Exception:
                    pass

            if not payload:
                return defaults
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                return defaults
            if not isinstance(parsed, dict):
                return defaults

        output_format = parsed.get("output_format", defaults["output_format"])
        if output_format not in VALID_OUTPUT_FORMATS:
            output_format = defaults["output_format"]

        add_subtitles = parsed.get("add_subtitles", defaults["add_subtitles"])
        if not isinstance(add_subtitles, bool):
            add_subtitles = defaults["add_subtitles"]

        return {
            "output_format": output_format,
            "add_subtitles": add_subtitles,
            "webcam_region": normalize_webcam_region(parsed.get("webcam_region")),
            "hook_intro": parsed.get("hook_intro") if isinstance(parsed.get("hook_intro"), bool) else None,
            # Kortes Desktop free plan: every render of this task carries the Kortes mark.
            "watermark": parsed.get("watermark") is True,
            "free_clips": parsed.get("free_clips") if isinstance(parsed.get("free_clips"), int) else None,
            "clip_count": normalize_clip_count(parsed.get("clip_count")),
            "strictness": parsed.get("strictness") if parsed.get("strictness") in {"more", "balanced", "best"} else "balanced",
            "title_overlay": parsed.get("title_overlay") is not False,
            **normalize_clip_cleanup_settings(
                parsed.get("cut_long_pauses"),
                parsed.get("pause_threshold_ms"),
                parsed.get("remove_filler_words"),
                parsed.get("filtered_words"),
            ),
        }
