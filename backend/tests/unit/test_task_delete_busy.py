from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import DBAPIError
import pytest

from src.api.routes import tasks
from src.database import get_db


class _LockTimeout(Exception):
    sqlstate = "55P03"


async def _delete(monkeypatch, error):
    service = SimpleNamespace(
        task_repo=SimpleNamespace(
            get_task_by_id=AsyncMock(return_value={"id": "task", "user_id": "owner"})
        ),
        delete_task=AsyncMock(side_effect=error),
    )
    monkeypatch.setattr(tasks, "TaskService", lambda db: service)
    monkeypatch.setattr(tasks, "_get_user_id_from_headers", AsyncMock(return_value="owner"))
    db = SimpleNamespace(execute=AsyncMock(), close=AsyncMock())
    app = FastAPI()
    app.include_router(tasks.router)
    app.dependency_overrides[get_db] = lambda: db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        response = await http.delete("/tasks/task")
    return response, db


@pytest.mark.asyncio
async def test_delete_behind_a_long_edit_answers_409_quickly(monkeypatch):
    # "Apply to all" holds the task's row lock while it re-renders every clip.
    error = DBAPIError("SELECT ... FOR UPDATE", {}, _LockTimeout())
    response, db = await _delete(monkeypatch, error)

    assert response.status_code == 409
    assert "refeitos" in response.json()["detail"]
    statement = str(db.execute.await_args_list[0].args[0])
    assert "lock_timeout" in statement


@pytest.mark.asyncio
async def test_delete_still_works_when_nothing_holds_the_task(monkeypatch):
    response, _ = await _delete(monkeypatch, None)
    assert response.status_code == 200
