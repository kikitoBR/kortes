"""Kortes Desktop setup: the license and the AssemblyAI key (only in the desktop edition)."""

import logging
import re
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth_headers import resolve_authenticated_user_id
from ...config import get_config
from ...database import get_db
from ...desktop import (
    ACCOUNT_TOKEN_SETTING,
    SetupError,
    account_token,
    check_assemblyai_key,
    check_license,
    save_settings,
    site_request,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/desktop", tags=["desktop"])


class KeyPayload(BaseModel):
    key: str


class AccountPayload(BaseModel):
    email: str
    password: str
    name: str = ""


class SupportPayload(BaseModel):
    category: str = "support"
    message: str
    contact: str = ""


class SupportReply(BaseModel):
    message: str


def _error(exc: SetupError) -> JSONResponse:
    return JSONResponse({"detail": exc.message, "code": exc.code}, status_code=exc.status)


def _license_payload(info) -> dict:
    return {
        "name": info.name,
        "status": info.status,
        "expires_at": info.expires_at,
        "devices": info.devices,
        "max_devices": info.max_devices,
    }


@router.get("/setup")
async def get_setup(request: Request, db: AsyncSession = Depends(get_db)):
    """What is configured. The license is checked live, so the page shows its real state."""
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    license_state: dict = {"configured": bool(config.openai_api_key)}
    if config.openai_api_key:
        try:
            info = await check_license(config.openai_api_key, config.license_server_url)
            license_state["info"] = _license_payload(info)
        except SetupError as exc:
            license_state["error"] = {"code": exc.code, "message": exc.message}
    assemblyai_configured = bool(config.assembly_ai_api_key)
    account = await _account_state(db)
    return {
        "account": account,
        "license": license_state,
        "assemblyai": {"configured": assemblyai_configured},
        "transcription": "assemblyai" if assemblyai_configured else "whisper",
        "whisper_fallback": config.transcription_fallback == "whisper",
        # Signed in (the license comes with the account); a license typed by hand
        # before accounts existed still works.
        "ready": bool(account.get("signed_in")) or license_state.get("info") is not None,
    }


async def _account_state(db: AsyncSession) -> dict:
    """The signed-in account, read live from the site (plan and free cuts left)."""
    token = account_token()
    if not token:
        return {"signed_in": False}
    config = get_config()
    status, body = await site_request("GET", "/account", site_url=config.kortes_site_url, license_key=token)
    if status == 200 and isinstance(body, dict):
        return {"signed_in": True, **body}
    if status in (401, 403) and isinstance(body, dict):
        # Signed out on the site (session replaced, account moved or blocked): sign out here too.
        if body.get("code") in {"signed_out", "other_device", "blocked"}:
            await save_settings(db, {ACCOUNT_TOKEN_SETTING: None, "OPENAI_API_KEY": None})
        return {"signed_in": False, "error": body.get("detail")}
    # Site unreachable: keep working with what is saved.
    return {"signed_in": True, "offline": True}


async def _account_call(path: str, payload: AccountPayload, request: Request, db: AsyncSession):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    status, body = await site_request(
        "POST", path, site_url=config.kortes_site_url, license_key=None,
        payload={"email": payload.email, "password": payload.password, "name": payload.name},
    )
    if status == 200 and isinstance(body, dict) and body.get("token") and body.get("license"):
        await save_settings(db, {ACCOUNT_TOKEN_SETTING: body["token"], "OPENAI_API_KEY": body["license"]})
        logger.info("Desktop signed in to its Kortes account")
        return {"account": {"signed_in": True, **(body.get("account") or {})}}
    return _relay(status, body)


@router.post("/account/login")
async def account_login(payload: AccountPayload, request: Request, db: AsyncSession = Depends(get_db)):
    return await _account_call("/auth/login", payload, request, db)


@router.post("/account/signup")
async def account_signup(payload: AccountPayload, request: Request, db: AsyncSession = Depends(get_db)):
    return await _account_call("/auth/signup", payload, request, db)


@router.post("/account/set-password")
async def account_set_password(payload: AccountPayload, request: Request, db: AsyncSession = Depends(get_db)):
    """First access of an account bought on Kirvano: its first password."""
    return await _account_call("/auth/set-password", payload, request, db)


@router.get("/account")
async def get_account(request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    return await _account_state(db)


@router.post("/account/logout")
async def account_logout(request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    token = account_token()
    if token:
        await site_request("POST", "/auth/logout", site_url=config.kortes_site_url, license_key=token)
    await save_settings(db, {ACCOUNT_TOKEN_SETTING: None, "OPENAI_API_KEY": None})
    return {"account": {"signed_in": False}}


@router.post("/license")
async def set_license(payload: KeyPayload, request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    key = payload.key.strip()
    try:
        info = await check_license(key, config.license_server_url)
    except SetupError as exc:
        return _error(exc)
    await save_settings(db, {"OPENAI_API_KEY": key})
    logger.info("Desktop license saved for %s", info.name)
    return {"license": _license_payload(info)}


@router.delete("/license")
async def remove_license(request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    await save_settings(db, {"OPENAI_API_KEY": None})
    return {"ok": True}


@router.post("/assemblyai")
async def set_assemblyai(payload: KeyPayload, request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    key = payload.key.strip()
    try:
        await check_assemblyai_key(key)
    except SetupError as exc:
        return _error(exc)
    await save_settings(db, {"ASSEMBLY_AI_API_KEY": key})
    return {"assemblyai": {"configured": True}}


@router.delete("/assemblyai")
async def remove_assemblyai(request: Request, db: AsyncSession = Depends(get_db)):
    """Without a key, every video is transcribed by Whisper on this computer."""
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    await save_settings(db, {"ASSEMBLY_AI_API_KEY": None})
    return {"assemblyai": {"configured": False}}


# Support and "Novidades": relayed to the Kortes site with this PC's license.

_announcements_cache: dict = {"until": 0.0, "items": []}
ANNOUNCEMENTS_CACHE_SECONDS = 60


@router.get("/announcements")
async def get_announcements(request: Request, db: AsyncSession = Depends(get_db)):
    """Published announcements. When the site is unreachable, the last list (or none)."""
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    now = time.monotonic()
    if _announcements_cache["until"] > now:
        return {"announcements": _announcements_cache["items"]}
    status, body = await site_request("GET", "/announcements", site_url=config.kortes_site_url, license_key=None)
    if status == 200 and isinstance(body, dict) and isinstance(body.get("announcements"), list):
        _announcements_cache.update(until=now + ANNOUNCEMENTS_CACHE_SECONDS, items=body["announcements"])
    else:
        _announcements_cache["until"] = now + 60
    return {"announcements": _announcements_cache["items"]}


def _relay(status: int, body) -> JSONResponse:
    return JSONResponse(body if isinstance(body, dict) else {"detail": "Resposta inválida do servidor do Kortes."}, status_code=status)


def _no_license() -> JSONResponse:
    return JSONResponse(
        {"detail": "Ative sua licença em Configurações para falar com o suporte.", "code": "license_missing"},
        status_code=400,
    )


@router.get("/support")
async def list_support(request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    if not config.openai_api_key:
        return _no_license()
    return _relay(*await site_request(
        "GET", "/support", site_url=config.kortes_site_url, license_key=config.openai_api_key
    ))


@router.post("/support")
async def create_support(payload: SupportPayload, request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    if not config.openai_api_key:
        return _no_license()
    return _relay(*await site_request(
        "POST", "/support", site_url=config.kortes_site_url, license_key=config.openai_api_key,
        payload=payload.model_dump(),
    ))


@router.post("/support/{thread_id}/messages")
async def reply_support(thread_id: str, payload: SupportReply, request: Request, db: AsyncSession = Depends(get_db)):
    config = get_config()
    await resolve_authenticated_user_id(request, db, config)
    if not config.openai_api_key:
        return _no_license()
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", thread_id):
        return JSONResponse({"detail": "Conversa não encontrada."}, status_code=404)
    return _relay(*await site_request(
        "POST", f"/support/{thread_id}/messages", site_url=config.kortes_site_url,
        license_key=config.openai_api_key, payload=payload.model_dump(),
    ))
