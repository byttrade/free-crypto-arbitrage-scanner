"""Telegram как в bytx examples/06_telegram_alerts.py — aiohttp, свой бот."""
from __future__ import annotations

import time

import aiohttp

from . import settings

_sent: dict[str, float] = {}
_offset = 0
_window: list[float] = []
_dropped = 0


def take_slot(limit: int, now: float | None = None) -> bool:
    """Общий лимит сообщений в минуту: при старте над порогом сразу сотня связок."""
    global _dropped
    now = time.time() if now is None else now
    _window[:] = [t for t in _window if now - t < 60]
    if len(_window) >= max(1, int(limit)):
        _dropped += 1
        return False
    _window.append(now)
    return True


def take_dropped() -> int:
    global _dropped
    n, _dropped = _dropped, 0
    return n


async def _api(method: str, body: dict | None = None) -> dict | None:
    token = settings.get()["telegramToken"]
    if not token:
        return None
    async with aiohttp.ClientSession() as s:
        async with s.post(f"https://api.telegram.org/bot{token}/{method}", json=body or {}) as r:
            return await r.json()


async def send(text: str) -> str | None:
    chat = settings.get()["telegramChatId"]
    if not chat:
        return "нет chat id — напишите /start боту"
    r = await _api("sendMessage", {"chat_id": chat, "text": text, "disable_web_page_preview": True})
    if not r or not r.get("ok"):
        return (r or {}).get("description", "ошибка telegram")
    return None


async def poll_bot() -> None:
    global _offset
    if not settings.get()["telegramToken"]:
        return
    r = await _api("getUpdates", {"offset": _offset, "timeout": 0})
    if not r or not r.get("ok"):
        return
    for u in r.get("result") or []:
        _offset = u["update_id"] + 1
        msg = u.get("message") or {}
        text = msg.get("text") or ""
        chat = (msg.get("chat") or {}).get("id")
        if chat and text.startswith("/start"):
            settings.save({"telegramChatId": str(chat)})
            await _api("sendMessage", {
                "chat_id": chat,
                "text": "BYTtrade Arb Terminal: алерты включены. Порог и скорость спреда — в настройках панели.",
            })


def can_send(key: str, cooldown_s: float) -> bool:
    now = time.time()
    if now - _sent.get(key, 0) < cooldown_s:
        return False
    _sent[key] = now
    return True
