import importlib

import pytest

from src.media import transcription


def test_whisper_progress_reaches_the_callback_of_its_thread():
    pytest.importorskip("whisper")
    whisper_transcribe = importlib.import_module("whisper.transcribe")
    transcription._install_whisper_progress_bar()
    seen = []
    transcription._whisper_progress.callback = seen.append
    try:
        # Whisper hides its bar (disable=True) unless verbose=False; ours still counts.
        with whisper_transcribe.tqdm.tqdm(total=200, unit="frames", disable=True) as bar:
            bar.update(50)
            bar.update(150)
    finally:
        transcription._whisper_progress.callback = None
    assert seen == [0.25, 1.0]


def test_without_a_callback_the_bar_stays_whispers_own():
    pytest.importorskip("whisper")
    whisper_transcribe = importlib.import_module("whisper.transcribe")
    transcription._install_whisper_progress_bar()
    with whisper_transcribe.tqdm.tqdm(total=10, disable=True) as bar:
        bar.update(10)
        assert bar.n == 0  # disabled as Whisper asked: nothing counted or printed
