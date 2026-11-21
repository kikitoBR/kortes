import json
import shutil
import subprocess

import pytest

from src.media.voice_energy import (
    annotate_transcript,
    energy_peak_times,
    energy_zscores,
    measure_voice_energy,
    parse_rms_levels,
    peak_level,
    strip_markers,
)

TRANSCRIPT = "\n".join(
    [
        "[00:00 - 00:05] bom dia chat",
        "[00:05 - 00:09] CORRE CORRE ELE TÁ ATRÁS",
        "[01:00 - 01:04] voltei pessoal",
    ]
)


def levels_with_peaks():
    # 70 s at a calm -30 dB, a shout at 5-8 s and a loud game moment at 40 s.
    levels = [-30.0] * 70
    for second in range(5, 9):
        levels[second] = -6.0
    levels[40] = -8.0
    return levels


def test_rms_levels_parse_silence_as_the_floor():
    output = "frame:0\nlavfi.astats.Overall.RMS_level=-23.5\nlavfi.astats.Overall.RMS_level=-inf\n"
    assert parse_rms_levels(output) == [-23.5, -90.0]


def test_peaks_are_measured_against_the_video_average():
    z = energy_zscores(levels_with_peaks())
    assert z[6] > 2.5 and z[40] > 2.5 and abs(z[20]) < 0.5
    # Silence does not drag the average down.
    assert energy_zscores([-90.0] * 30 + [-30.0, -29.0, -31.0])[0] < -10
    assert energy_peak_times(z, max_peaks=5) == [5.0, 40.0]


def test_a_line_only_counts_the_seconds_it_covers():
    z = energy_zscores(levels_with_peaks())
    assert peak_level(z, 0, 5) < 1  # ends where the shout starts
    assert peak_level(z, 5, 9) > 2.5


def test_transcript_marks_peaks_and_loud_speechless_gaps():
    annotated = annotate_transcript(TRANSCRIPT, energy_zscores(levels_with_peaks()))
    lines = annotated.splitlines()
    assert lines[0] == "[00:00 - 00:05] bom dia chat"
    assert lines[1].endswith("🔊🔊")
    assert lines[2].startswith("(00:09 to 01:00: no speech; loud game sound")
    assert lines[3] == "[01:00 - 01:04] voltei pessoal"
    assert strip_markers(lines[1]) == "[00:05 - 00:09] CORRE CORRE ELE TÁ ATRÁS"
    assert annotate_transcript(TRANSCRIPT, None) == TRANSCRIPT


def test_analysis_prompt_carries_the_markers():
    from src.ai import build_candidate_rerank_prompt, build_transcript_analysis_prompt
    from src.ai import TranscriptSegment

    z = energy_zscores(levels_with_peaks())
    prompt = build_transcript_analysis_prompt(TRANSCRIPT, voice_energy=z)
    assert "CORRE CORRE ELE TÁ ATRÁS 🔊🔊" in prompt
    assert "Voice energy" in prompt
    assert "🔊" not in build_transcript_analysis_prompt(TRANSCRIPT)

    segment = TranscriptSegment.model_validate(
        {"start_time": "00:00", "end_time": "00:20", "text": "x", "relevance_score": 0.5, "reasoning": "r"}
    )
    assert "voice peak: very strong" in build_candidate_rerank_prompt([segment], voice_energy=z)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg required")
def test_energy_is_measured_per_second_and_kept_with_the_transcript(tmp_path):
    source = tmp_path / "live.m4a"
    # Quiet tone, a loud burst at 3-5 s, quiet again.
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
            "-i", "aevalsrc='if(between(t,3,5),0.8,0.02)*sin(2*PI*440*t)':s=48000:d=8",
            "-c:a", "aac", str(source),
        ],
        check=True,
        capture_output=True,
    )
    cache = tmp_path / "live.transcript_cache.json"
    cache.write_text(json.dumps({"words": [], "text": ""}))
    levels = measure_voice_energy(source)
    assert 7 <= len(levels) <= 9
    assert levels[4] - levels[1] > 20
    assert json.loads(cache.read_text())["voice_energy_db"] == levels
    source.unlink()
    assert measure_voice_energy(source) == levels  # read back without the media
