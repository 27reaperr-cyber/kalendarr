import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl

import pytz
from aiogram.types import Update
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from bot import (
    BOT_TOKEN,
    add_task,
    create_bot,
    create_dispatcher,
    db_init,
    delete_task,
    get_task,
    get_tasks,
    get_user_tz,
    local_to_utc,
    send_reminders,
    update_task,
    upsert_user,
    utc_to_local,
)

WEBHOOK_PATH = "/webhook"
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "change-me")
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "").rstrip("/")
WEBAPP_AUTH_MAX_AGE = int(os.getenv("WEBAPP_AUTH_MAX_AGE", "86400"))

app = FastAPI(title="Telegram Calendar WebApp")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


class TaskPayload(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    scheduled_local: str = Field(description="YYYY-MM-DD HH:MM")


class TimezonePayload(BaseModel):
    timezone: str


class TaskResponse(BaseModel):
    id: int
    text: str
    scheduled_utc: str
    scheduled_local: str
    reminded: int


def _parse_local_datetime(local_dt: str) -> str:
    try:
        datetime.strptime(local_dt, "%Y-%m-%d %H:%M")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="scheduled_local must be in format YYYY-MM-DD HH:MM",
        ) from exc
    return local_dt


def verify_telegram_webapp_data(init_data: str) -> dict[str, Any]:
    if not init_data:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing initData")

    try:
        data = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid initData") from exc

    received_hash = data.pop("hash", None)
    if not received_hash:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing hash")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(
        secret_key,
        data_check_string.encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Telegram signature")

    auth_date = data.get("auth_date")
    if auth_date is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing auth_date")

    try:
        auth_ts = int(auth_date)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid auth_date") from exc

    now_ts = int(datetime.now(timezone.utc).timestamp())
    if now_ts - auth_ts > WEBAPP_AUTH_MAX_AGE:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="initData expired")

    user_json = data.get("user")
    if not user_json:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing user data")

    try:
        user_obj = json.loads(user_json)
        user_id = int(user_obj["id"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user data") from exc

    return {"user_id": user_id, "user": user_obj, "raw": data}


async def get_current_user(
    x_telegram_init_data: str | None = Header(default=None),
) -> dict[str, Any]:
    auth = verify_telegram_webapp_data(x_telegram_init_data or "")
    upsert_user(auth["user_id"])
    return auth


def _row_to_task_response(row: Any, user_tz: str) -> TaskResponse:
    return TaskResponse(
        id=row["id"],
        text=row["text"],
        scheduled_utc=row["scheduled_utc"],
        scheduled_local=utc_to_local(row["scheduled_utc"], user_tz),
        reminded=row["reminded"],
    )


@app.on_event("startup")
async def on_startup() -> None:
    db_init()

    bot = create_bot()
    dispatcher = create_dispatcher()

    app.state.bot = bot
    app.state.dispatcher = dispatcher

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        send_reminders,
        trigger="interval",
        seconds=60,
        args=[bot],
        id="send-reminders",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    app.state.scheduler = scheduler

    if WEBHOOK_URL:
        await bot.set_webhook(
            url=f"{WEBHOOK_URL}{WEBHOOK_PATH}",
            secret_token=WEBHOOK_SECRET,
            allowed_updates=["message", "callback_query"],
            drop_pending_updates=False,
        )


@app.on_event("shutdown")
async def on_shutdown() -> None:
    scheduler: AsyncIOScheduler = app.state.scheduler
    scheduler.shutdown(wait=False)

    bot = app.state.bot
    if WEBHOOK_URL:
        await bot.delete_webhook(drop_pending_updates=False)
    await bot.session.close()


@app.get("/", response_class=HTMLResponse)
async def webapp_index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post(WEBHOOK_PATH)
async def telegram_webhook(request: Request) -> JSONResponse:
    secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if WEBHOOK_SECRET and secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid webhook secret")

    body = await request.json()
    update = Update.model_validate(body, context={"bot": app.state.bot})
    await app.state.dispatcher.feed_update(app.state.bot, update)
    return JSONResponse({"ok": True})


@app.get("/api/tasks", response_model=list[TaskResponse])
async def api_get_tasks(user=Depends(get_current_user)) -> list[TaskResponse]:
    user_id = user["user_id"]
    user_tz = get_user_tz(user_id)
    rows = get_tasks(user_id, future_only=False)
    return [_row_to_task_response(row, user_tz) for row in rows]


@app.post("/api/tasks", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def api_create_task(payload: TaskPayload, user=Depends(get_current_user)) -> TaskResponse:
    user_id = user["user_id"]
    user_tz = get_user_tz(user_id)

    local_dt = _parse_local_datetime(payload.scheduled_local)
    scheduled_utc = local_to_utc(local_dt, user_tz)

    task_id = add_task(user_id, payload.text.strip(), scheduled_utc)
    task_row = get_task(task_id)
    return _row_to_task_response(task_row, user_tz)


@app.put("/api/tasks/{task_id}", response_model=TaskResponse)
async def api_update_task(task_id: int, payload: TaskPayload, user=Depends(get_current_user)) -> TaskResponse:
    user_id = user["user_id"]
    row = get_task(task_id)
    if not row or row["user_id"] != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    user_tz = get_user_tz(user_id)
    local_dt = _parse_local_datetime(payload.scheduled_local)
    scheduled_utc = local_to_utc(local_dt, user_tz)

    update_task(task_id, payload.text.strip(), scheduled_utc)
    updated_row = get_task(task_id)
    return _row_to_task_response(updated_row, user_tz)


@app.delete("/api/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def api_delete_task(task_id: int, user=Depends(get_current_user)) -> Response:
    user_id = user["user_id"]
    row = get_task(task_id)
    if not row or row["user_id"] != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    delete_task(task_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/user/timezone")
async def api_get_timezone(user=Depends(get_current_user)) -> dict[str, str]:
    user_id = user["user_id"]
    return {"timezone": get_user_tz(user_id)}


@app.put("/api/user/timezone")
async def api_set_timezone(payload: TimezonePayload, user=Depends(get_current_user)) -> dict[str, str]:
    if payload.timezone not in pytz.all_timezones_set:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid timezone")

    user_id = user["user_id"]
    upsert_user(user_id, payload.timezone)
    return {"timezone": payload.timezone}

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )