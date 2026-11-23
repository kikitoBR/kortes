"""Kortes Desktop: this computer's identity and the customer's two keys.

- The license (``kl_...``) is the AI key. Calls go to the license server
  (``KORTES_LICENSE_URL``, an OpenAI-compatible API) with this computer's id in
  ``x-kortes-device``, so a license works on a limited number of computers.
- The AssemblyAI key is the customer's own; without it, or when it fails,
  transcription runs on local Whisper (``TRANSCRIPTION_FALLBACK``).

Both keys are saved like any runtime setting: encrypted in ``app_settings``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .runtime_settings import encrypt_setting_value, load_runtime_settings_cache

logger = logging.getLogger(__name__)

DEVICE_HEADER = "x-kortes-device"
ASSEMBLYAI_CHECK_URL = "https://api.assemblyai.com/v2/transcript?limit=1"
CHECK_TIMEOUT_SECONDS = 20


class SetupError(Exception):
    """A key that cannot be used, with a message the customer can act on."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _data_dir() -> Path:
    return Path(os.getenv("KORTES_DATA_DIR") or os.getenv("TEMP_DIR") or "/tmp")


def device_id() -> str:
    """This computer's id, stable across restarts.

    The launcher passes the machine's own id in ``KORTES_DEVICE_ID``; otherwise
    a random id is kept in the data folder. Only a hash leaves the computer.
    """
    raw = (os.getenv("KORTES_DEVICE_ID") or "").strip()
    if not raw:
        path = _data_dir() / "device_id"
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            raw = ""
        if not raw:
            raw = uuid.uuid4().hex
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(raw, encoding="utf-8")
            except OSError as exc:
                logger.warning("Could not keep the device id in %s: %s", path, exc)
    return hashlib.sha256(f"kortes-device:{raw}".encode("utf-8")).hexdigest()[:32]


def device_headers() -> dict[str, str]:
    return {DEVICE_HEADER: device_id()}


async def site_request(
    method: str,
    path: str,
    *,
    site_url: str,
    license_key: Optional[str],
    payload: Optional[dict[str, Any]] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> tuple[int, Any]:
    """Call the Kortes site (support messages, announcements) as this customer.

    The site checks the license with the license server and keeps only its hash.
    Returns (status, JSON body); an unreachable site is a 502 with a message.
    """
    headers = {**device_headers(), "x-kortes-version": os.getenv("KORTES_APP_VERSION", "")}
    if license_key:
        headers["Authorization"] = f"Bearer {license_key}"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=CHECK_TIMEOUT_SECONDS) as client:
            response = await client.request(method, f"{site_url}/api/v1{path}", headers=headers, json=payload)
    except httpx.HTTPError as exc:
        logger.warning("Kortes site unreachable: %s", exc)
        return 502, {"detail": "Não deu para falar com o servidor do Kortes. Confira a internet e tente de novo."}
    try:
        body = response.json()
    except ValueError:
        body = {"detail": f"O servidor do Kortes respondeu com erro {response.status_code}."}
    return response.status_code, body


@dataclass
class LicenseInfo:
    name: str
    status: str
    expires_at: Optional[str]
    monthly_tokens: int
    used_tokens: int
    devices: int
    max_devices: int

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LicenseInfo":
        return cls(
            name=str(payload.get("name") or ""),
            status=str(payload.get("status") or ""),
            expires_at=payload.get("expires_at"),
            monthly_tokens=int(payload.get("monthly_tokens") or 0),
            used_tokens=int(payload.get("used_tokens") or 0),
            devices=int(payload.get("devices") or 0),
            max_devices=int(payload.get("max_devices") or 0),
        )


def _server_error(response: httpx.Response) -> SetupError:
    try:
        error = response.json().get("error") or {}
    except ValueError:
        error = {}
    code = error.get("code") or "license_error"
    message = error.get("message") or "O servidor de licenças recusou a chave."
    return SetupError(str(code), str(message), 400)


async def check_license(
    key: str, base_url: str, *, transport: Optional[httpx.AsyncBaseTransport] = None
) -> LicenseInfo:
    """Ask the license server about this key (it also registers this computer)."""
    key = (key or "").strip()
    if not key.startswith("kl_"):
        raise SetupError("invalid_license", "A chave de licença começa com kl_. Confira se copiou inteira.")
    try:
        async with httpx.AsyncClient(transport=transport, timeout=CHECK_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{base_url}/license",
                headers={"Authorization": f"Bearer {key}", **device_headers()},
            )
    except httpx.HTTPError as exc:
        logger.warning("License server unreachable: %s", exc)
        raise SetupError(
            "license_server_unreachable",
            "Não deu para falar com o servidor de licenças. Confira a internet e tente de novo.",
            502,
        )
    if response.status_code != 200:
        raise _server_error(response)
    return LicenseInfo.from_payload(response.json())


async def check_assemblyai_key(
    key: str, *, transport: Optional[httpx.AsyncBaseTransport] = None
) -> None:
    """A cheap authenticated call: lists at most one transcript."""
    key = (key or "").strip()
    if len(key) < 20:
        raise SetupError("invalid_assemblyai_key", "Essa chave da AssemblyAI parece incompleta. Copie de novo do painel.")
    try:
        async with httpx.AsyncClient(transport=transport, timeout=CHECK_TIMEOUT_SECONDS) as client:
            response = await client.get(ASSEMBLYAI_CHECK_URL, headers={"authorization": key})
    except httpx.HTTPError as exc:
        logger.warning("AssemblyAI unreachable: %s", exc)
        raise SetupError(
            "assemblyai_unreachable",
            "Não deu para falar com a AssemblyAI. Confira a internet e tente de novo.",
            502,
        )
    if response.status_code in (401, 403):
        raise SetupError("invalid_assemblyai_key", "A AssemblyAI não aceitou essa chave. Copie de novo do painel.")
    if response.status_code >= 400:
        raise SetupError(
            "assemblyai_error",
            f"A AssemblyAI respondeu com erro {response.status_code}. Tente de novo em instantes.",
            502,
        )


async def save_settings(db: AsyncSession, updates: dict[str, Optional[str]]) -> None:
    """Save (value) or remove (None) runtime settings, then reload them in this process."""
    for key, value in updates.items():
        if value:
            await db.execute(
                text(
                    """
                    INSERT INTO app_settings (setting_key, encrypted_value, prefer_admin_value)
                    VALUES (:setting_key, :encrypted_value, TRUE)
                    ON CONFLICT (setting_key) DO UPDATE
                    SET encrypted_value = EXCLUDED.encrypted_value,
                        prefer_admin_value = TRUE,
                        updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"setting_key": key, "encrypted_value": encrypt_setting_value(value)},
            )
        else:
            await db.execute(
                text("DELETE FROM app_settings WHERE setting_key = :setting_key"),
                {"setting_key": key},
            )
    await db.commit()
    await load_runtime_settings_cache(db)
