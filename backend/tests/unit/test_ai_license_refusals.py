from types import SimpleNamespace

import pytest
from pydantic_ai.exceptions import ModelHTTPError

from src import ai


def _agent(error):
    async def run(_prompt):
        calls.append(1)
        raise error
    calls: list = []
    return SimpleNamespace(run=run), calls


@pytest.mark.asyncio
async def test_a_spent_quota_is_not_retried_nor_named():
    error = ModelHTTPError(429, "kortes", {"message": "A cota de IA deste mês acabou.", "type": "license_error", "code": "quota_exceeded"})
    agent, calls = _agent(error)
    with pytest.raises(RuntimeError) as raised:
        await ai._run_transcript_analysis(agent, "prompt", timeout_seconds=5)
    assert calls == [1]
    assert "cota" not in str(raised.value).lower() and "limite" not in str(raised.value).lower()
    assert "suporte" in str(raised.value)


@pytest.mark.asyncio
async def test_an_expired_license_shows_the_servers_message():
    error = ModelHTTPError(403, "kortes", {"error": {"message": "Esta licença venceu. Renove para continuar.", "code": "license_expired"}})
    agent, calls = _agent(error)
    with pytest.raises(RuntimeError, match="Esta licença venceu"):
        await ai._run_transcript_analysis(agent, "prompt", timeout_seconds=5)
    assert calls == [1]


def test_a_busy_ai_is_still_retried():
    error = ModelHTTPError(429, "kortes", {"code": "upstream_busy"})
    assert ai._license_refusal(error) is None
    assert ai._is_transient_model_error(error)
