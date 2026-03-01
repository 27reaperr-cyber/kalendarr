import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import pytz
from aiogram import Bot, Dispatcher, Router
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DB_PATH = os.getenv("DB_PATH", "calendar_bot.db")
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://your-domain.com")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

router = Router()


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def db_init() -> None:
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id  INTEGER PRIMARY KEY,
                timezone TEXT    NOT NULL DEFAULT 'UTC'
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER NOT NULL,
                text          TEXT    NOT NULL,
                scheduled_utc TEXT    NOT NULL,
                reminded      INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
            """
        )
        conn.commit()


def get_user_tz(user_id: int) -> str:
    with db_connect() as conn:
        row = conn.execute(
            "SELECT timezone FROM users WHERE user_id=?", (user_id,)
        ).fetchone()
    return row["timezone"] if row else "UTC"


def upsert_user(user_id: int, tz: str = "UTC") -> None:
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO users (user_id, timezone) VALUES (?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET timezone=excluded.timezone",
            (user_id, tz),
        )
        conn.commit()


def add_task(user_id: int, text: str, scheduled_utc: str) -> int:
    with db_connect() as conn:
        cur = conn.execute(
            "INSERT INTO tasks (user_id, text, scheduled_utc) VALUES (?,?,?)",
            (user_id, text, scheduled_utc),
        )
        conn.commit()
        return int(cur.lastrowid)


def get_tasks(user_id: int, future_only: bool = True):
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    with db_connect() as conn:
        if future_only:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE user_id=? AND scheduled_utc >= ? ORDER BY scheduled_utc",
                (user_id, now_utc),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE user_id=? ORDER BY scheduled_utc",
                (user_id,),
            ).fetchall()
    return rows


def get_task(task_id: int):
    with db_connect() as conn:
        return conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()


def update_task(task_id: int, text: str, scheduled_utc: str) -> None:
    with db_connect() as conn:
        conn.execute(
            "UPDATE tasks SET text=?, scheduled_utc=?, reminded=0 WHERE id=?",
            (text, scheduled_utc, task_id),
        )
        conn.commit()


def delete_task(task_id: int) -> None:
    with db_connect() as conn:
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        conn.commit()


def mark_reminded(task_id: int) -> None:
    with db_connect() as conn:
        conn.execute("UPDATE tasks SET reminded=1 WHERE id=?", (task_id,))
        conn.commit()


def get_pending_reminders():
    now_utc = datetime.now(timezone.utc)
    remind_at = (now_utc + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M")
    now_str = now_utc.strftime("%Y-%m-%d %H:%M")
    with db_connect() as conn:
        return conn.execute(
            "SELECT * FROM tasks WHERE reminded=0 AND scheduled_utc <= ? AND scheduled_utc >= ?",
            (remind_at, now_str),
        ).fetchall()


def main_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="📅 Открыть календарь",
                    web_app=WebAppInfo(url=WEBAPP_URL),
                )
            ]
        ]
    )


def local_to_utc(local_dt: str, tz_name: str) -> str:
    tz = pytz.timezone(tz_name)
    naive = datetime.strptime(local_dt, "%Y-%m-%d %H:%M")
    localized = tz.localize(naive)
    return localized.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")


def utc_to_local(utc_dt: str, tz_name: str) -> str:
    tz = pytz.timezone(tz_name)
    dt_utc = datetime.strptime(utc_dt, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(tz).strftime("%Y-%m-%d %H:%M")


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    upsert_user(message.from_user.id)
    await message.answer(
        "<b>Личный календарь</b>\n\n"
        "Управляйте задачами через Telegram Web App. "
        "Напоминания приходят за 30 минут до события.",
        parse_mode=ParseMode.HTML,
        reply_markup=main_menu_kb(),
    )


async def send_reminders(bot: Bot) -> None:
    tasks = get_pending_reminders()
    for task in tasks:
        try:
            user_tz = get_user_tz(task["user_id"])
            dt_local = utc_to_local(task["scheduled_utc"], user_tz)
            await bot.send_message(
                task["user_id"],
                "⏰ <b>Напоминание</b>\n\n"
                f"Через 30 минут: <b>{task['text']}</b>\n"
                f"🕒 {dt_local} ({user_tz})",
                parse_mode=ParseMode.HTML,
                reply_markup=main_menu_kb(),
            )
            mark_reminded(task["id"])
            logger.info(
                "Reminder sent: task_id=%s user_id=%s", task["id"], task["user_id"]
            )
        except Exception as exc:
            logger.exception("Reminder error task_id=%s: %s", task["id"], exc)


def create_bot() -> Bot:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is required")
    return Bot(token=BOT_TOKEN)


def create_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(router)
    return dp
