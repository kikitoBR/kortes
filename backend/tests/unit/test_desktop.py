"""Kortes Desktop: license and AssemblyAI checks, device id, Whisper fallback, routes."""

from pathlib import Path

import httpx
import pytest

from src import desktop
from src.config import Config
from src.desktop import SetupError, check_assemblyai_key, check_license, device_id


def make_config(monkeypatch, **env) -> Config:
    monkeypatch.setenv("KORTES_EDITION", env.pop("edition", "desktop"))
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Config()


def test_the_desktop_edition_uses_the_license_server_for_ai(monkeypatch):
    monkeypatch.delenv("LLM", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    config = make_config(monkeypatch)

    assert config.desktop
    assert config.llm == "openai:kortes"
    assert config.openai_base_url == "https://gemini.kikito.site/v1"
    assert config.transcription_fallback == "whisper"


def test_the_web_edition_is_unchanged(monkeypatch):
    monkeypatch.delenv("TRANSCRIPTION_FALLBACK", raising=False)
    config = make_config(monkeypatch, edition="web")

    assert not config.desktop
    assert config.transcription_fallback == ""


def test_the_device_id_is_stable_and_hashed(monkeypatch, tmp_path):
    monkeypatch.delenv("KORTES_DEVICE_ID", raising=False)
    monkeypatch.setenv("KORTES_DATA_DIR", str(tmp_path))

    first, second = device_id(), device_id()

    assert first == second and len(first) == 32
    stored = (tmp_path / "device_id").read_text()
    assert stored not in first  # only a hash leaves the computer
    monkeypatch.setenv("KORTES_DEVICE_ID", "machine-guid")
    assert device_id() != first


def license_server(status=200, payload=None, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=payload or {})
    return httpx.MockTransport(handler)


async def test_a_valid_license_returns_its_details_and_sends_the_device(monkeypatch, tmp_path):
    monkeypatch.setenv("KORTES_DATA_DIR", str(tmp_path))
    seen = []
    payload = {"name": "Loja", "status": "active", "expires_at": None, "monthly_tokens": 100,
               "used_tokens": 5, "devices": 1, "max_devices": 2}

    info = await check_license("kl_abc", "https://lic.test/v1", transport=license_server(200, payload, seen))

    assert info.name == "Loja" and info.used_tokens == 5
    assert str(seen[0].url) == "https://lic.test/v1/license"
    assert seen[0].headers["authorization"] == "Bearer kl_abc"
    assert seen[0].headers["x-kortes-device"] == device_id()


async def test_the_license_server_message_reaches_the_customer():
    payload = {"error": {"code": "device_limit", "message": "Esta licença já está em uso em 2 computador(es)."}}

    with pytest.raises(SetupError) as error:
        await check_license("kl_abc", "https://lic.test/v1", transport=license_server(403, payload))

    assert error.value.code == "device_limit"
    assert "2 computador" in error.value.message


async def test_a_key_that_is_not_a_license_is_refused_before_any_call():
    seen = []
    with pytest.raises(SetupError) as error:
        await check_license("sk-123", "https://lic.test/v1", transport=license_server(seen=seen))
    assert error.value.code == "invalid_license"
    assert seen == []


async def test_an_unreachable_license_server_says_so():
    def down(request):
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(SetupError) as error:
        await check_license("kl_abc", "https://lic.test/v1", transport=httpx.MockTransport(down))
    assert error.value.code == "license_server_unreachable"


@pytest.mark.parametrize("status,code", [(401, "invalid_assemblyai_key"), (500, "assemblyai_error")])
async def test_assemblyai_keys_are_checked(status, code):
    with pytest.raises(SetupError) as error:
        await check_assemblyai_key("a" * 32, transport=license_server(status))
    assert error.value.code == code


async def test_a_good_assemblyai_key_passes():
    seen = []
    await check_assemblyai_key("a" * 32, transport=license_server(200, {"transcripts": []}, seen))
    assert seen[0].headers["authorization"] == "a" * 32


def test_without_an_assemblyai_key_desktop_transcribes_with_whisper(monkeypatch):
    from src.media import transcription

    config = make_config(monkeypatch)
    config.assembly_ai_api_key = None
    monkeypatch.setattr(transcription, "get_config", lambda: config)
    monkeypatch.setattr(transcription, "_get_transcript_with_whisper", lambda path, cfg: "whisper")
    monkeypatch.setattr(transcription, "_get_transcript_with_assemblyai",
                        lambda *a: pytest.fail("AssemblyAI must not be called without a key"))

    assert transcription.get_video_transcript(Path("video.mp4")) == "whisper"


def test_when_assemblyai_fails_desktop_falls_back_to_whisper(monkeypatch):
    from src.media import transcription

    config = make_config(monkeypatch)
    config.assembly_ai_api_key = "key"

    def broken(*args):
        raise RuntimeError("insufficient credits")

    monkeypatch.setattr(transcription, "get_config", lambda: config)
    monkeypatch.setattr(transcription, "_get_transcript_with_assemblyai", broken)
    monkeypatch.setattr(transcription, "_get_transcript_with_whisper", lambda path, cfg: "whisper")

    assert transcription.get_video_transcript(Path("video.mp4")) == "whisper"


def test_the_web_edition_keeps_assemblyai_errors(monkeypatch):
    from src.media import transcription

    monkeypatch.delenv("TRANSCRIPTION_FALLBACK", raising=False)
    config = make_config(monkeypatch, edition="web")
    config.assembly_ai_api_key = "key"

    def broken(*args):
        raise RuntimeError("insufficient credits")

    monkeypatch.setattr(transcription, "get_config", lambda: config)
    monkeypatch.setattr(transcription, "_get_transcript_with_assemblyai", broken)

    with pytest.raises(RuntimeError):
        transcription.get_video_transcript(Path("video.mp4"))


def route_paths(config) -> set:
    from src.config import set_config_override
    from src.main import create_app

    try:
        app = create_app(config=config)
    finally:
        set_config_override(None)
    return {getattr(route, "path", "") for route in app.routes}


def test_desktop_serves_setup_and_drops_web_only_routes(monkeypatch):
    paths = route_paths(make_config(monkeypatch))

    assert "/desktop/setup" in paths and "/desktop/license" in paths
    assert not any(p.startswith(("/social", "/api-keys", "/admin", "/account", "/feedback")) for p in paths)
    assert any(p.startswith("/tasks") for p in paths)


def test_the_web_edition_has_no_desktop_routes(monkeypatch):
    paths = route_paths(make_config(monkeypatch, edition="web"))

    assert not any(p.startswith("/desktop") for p in paths)
    assert any(p.startswith("/social") for p in paths)


def test_desktop_ai_calls_carry_the_device(monkeypatch, tmp_path):
    from src.ai import _build_transcript_model

    monkeypatch.setenv("KORTES_DATA_DIR", str(tmp_path))
    config = make_config(monkeypatch)
    config.openai_api_key = "kl_abc"

    model = _build_transcript_model(config)

    client = model.client if hasattr(model, "client") else model._provider.client
    assert client.default_headers["x-kortes-device"] == desktop.device_id()
    assert str(client.base_url).startswith("https://gemini.kikito.site/v1")
