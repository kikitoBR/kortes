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
import re
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



# ---------------------------------------------------------------- account (kortes.com.br)
ACCOUNT_TOKEN_SETTING = "KORTES_ACCOUNT_TOKEN"


def account_token() -> Optional[str]:
    """The signed-in account's session token (saved encrypted in app_settings)."""
    from .runtime_settings import get_cached_setting

    return get_cached_setting(ACCOUNT_TOKEN_SETTING)


def source_key(url: str, source_type: str) -> str:
    """What makes one video or live one free cut: the same source twice is refused."""
    import datetime
    import hashlib

    from .youtube_utils import get_youtube_video_id

    url = (url or "").strip()
    video_id = get_youtube_video_id(url) if source_type in {"youtube", "live"} else None
    if source_type == "live":
        # A Twitch/Kick channel is the same link every day: each day's live counts on its own.
        base = video_id or url.lower().split("?")[0].rstrip("/")
        return f"live:{base}:{datetime.date.today().isoformat()}"
    if video_id:
        return f"yt:{video_id}"
    if url.startswith("upload://"):
        return f"file:{hashlib.sha256(url.encode()).hexdigest()[:32]}"
    return f"url:{hashlib.sha256(url.lower().encode()).hexdigest()[:32]}"


FREE_CLIPS_PER_VIDEO = 5


async def claim_free_clip(site_url: str, url: str, source_type: str) -> dict:
    """Ask the site before cutting: paid plans pass, the free plan spends a cut.

    Returns {"pro": bool, "source": key, "clips": n} (n = the free plan's best cuts
    for this video or live); raises SetupError (402 when the free videos ran out or
    this one was already cut, 401 when signed out).
    """
    # Signed in: the account's session. Not signed in: a kl_ key typed by hand before
    # accounts existed (the site lets those cut freely, never an account's key).
    from .config import get_config

    token = account_token() or get_config().openai_api_key
    if not token:
        raise SetupError("signed_out", "Entre na sua conta do Kortes em Configurações.", 401)
    key = source_key(url, source_type)
    status, body = await site_request("POST", "/clips/claim", site_url=site_url, license_key=token, payload={"source": key})
    if status != 200:
        detail = body.get("detail") if isinstance(body, dict) else None
        code = body.get("code") if isinstance(body, dict) else None
        raise SetupError(str(code or "claim_failed"), str(detail or "Não deu para conferir o seu plano agora."), status)
    try:
        clips = max(1, int(body.get("clips") or FREE_CLIPS_PER_VIDEO))
    except (TypeError, ValueError):
        clips = FREE_CLIPS_PER_VIDEO
    return {"pro": bool(body.get("pro")), "source": key, "clips": clips}


async def settle_task_free_cuts(task_id: str, clips: Optional[int] = None) -> None:
    """A free video or live is done: tell the site how many cuts it really made, so
    the reserved ones it did not make go back to the balance (none made gives the
    video back too). ``clips`` defaults to the task's saved clips. Best effort."""
    from .config import get_config

    config = get_config()
    if not config.desktop:
        return
    try:
        from .database import AsyncSessionLocal
        from .repositories.task_repository import TaskRepository

        async with AsyncSessionLocal() as db:
            metadata = await TaskRepository.load_source_metadata(db, task_id)
            key = (metadata or {}).get("free_source")
            if not key:
                return
            if clips is None:
                task = await TaskRepository.get_task_by_id(db, task_id)
                clips = len((task or {}).get("generated_clips_ids") or [])
        token = account_token()
        if token:
            await site_request(
                "POST", "/clips/settle", site_url=config.kortes_site_url, license_key=token,
                payload={"source": key, "clips": int(clips)},
            )
    except Exception:
        logger.warning("Could not settle the free cuts of task %s", task_id, exc_info=True)


async def release_free_clip(site_url: str, key: str) -> None:
    """Give a reserved free cut back (the video gave no cut). Best effort."""
    token = account_token()
    if token and key:
        await site_request("POST", "/clips/release", site_url=site_url, license_key=token, payload={"source": key})


# ---------------------------------------------------------------- the cuts' folder
_UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def _safe_name(value: str, limit: int) -> str:
    """A Windows-safe file or folder name (no reserved characters, no trailing dot)."""
    name = _UNSAFE_NAME.sub(" ", value or "").strip().strip(".")
    return " ".join(name.split())[:limit].strip() or "Kortes"


def copy_clip_to_folder(folder: str, source_title: str, clip_path: str, order: int, title: str) -> Optional[Path]:
    """Copy one cut to ``folder``/<video title>/<NN - cut title>.mp4, replacing an
    older version of the same cut (a re-render, a new title)."""
    import shutil

    clip = Path(clip_path)
    if not folder or not clip.exists():
        return None
    target_dir = Path(folder) / _safe_name(source_title, 80)
    target_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"{int(order):02d} - "
    for old in target_dir.glob(f"{prefix}*.mp4"):
        old.unlink(missing_ok=True)
    target = target_dir / f"{prefix}{_safe_name(title or f'Corte {order}', 70)}{clip.suffix or '.mp4'}"
    shutil.copy2(clip, target)
    return target


async def export_clip(task_id: str, clip_path: str, order: int, title: Optional[str] = None) -> None:
    """Kortes Desktop: a copy of every finished cut goes to the folder picked in
    Configurações (users.video_defaults.exportDir). Best effort: a full disk or a
    folder that is gone never fails the cut."""
    from .config import get_config

    if not get_config().desktop:
        return
    try:
        from sqlalchemy import text as sql_text

        from .database import AsyncSessionLocal
        from .utils.async_helpers import run_in_thread

        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    sql_text(
                        "SELECT u.video_defaults->>'exportDir' AS folder, s.title AS source_title "
                        "FROM tasks t JOIN users u ON u.id = t.user_id "
                        "LEFT JOIN sources s ON s.id = t.source_id WHERE t.id = :task_id"
                    ),
                    {"task_id": task_id},
                )
            ).first()
        if not row or not row.folder:
            return
        target = await run_in_thread(
            copy_clip_to_folder, row.folder, row.source_title or "Kortes", clip_path, order, title or ""
        )
        if target:
            logger.info("Cut %d of task %s copied to %s", order, task_id, target)
    except Exception:
        logger.warning("Could not copy cut %d of task %s to the cuts' folder", order, task_id, exc_info=True)
