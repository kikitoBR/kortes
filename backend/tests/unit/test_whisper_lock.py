import threading
import time
from pathlib import Path

from src.media import transcription


class _Model:
    """Records how many transcriptions run at the same time."""

    def __init__(self):
        self.running = 0
        self.most = 0
        self.guard = threading.Lock()

    def transcribe(self, *args, **kwargs):
        with self.guard:
            self.running += 1
            self.most = max(self.most, self.running)
        time.sleep(0.05)
        with self.guard:
            self.running -= 1
        return {"segments": [], "text": ""}


def test_whisper_transcriptions_take_turns(monkeypatch):
    # The live worker transcribes several pieces at once; the shared model must not.
    model = _Model()
    monkeypatch.setattr(transcription, "_prepare_audio_for_transcription", lambda path: path)
    monkeypatch.setattr(transcription, "_get_whisper_model", lambda name: model)
    threads = [
        threading.Thread(target=transcription.transcribe_with_whisper, args=(Path(f"piece{i}.ts"),))
        for i in range(3)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert model.most == 1
