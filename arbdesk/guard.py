"""Только локальный доступ: Host и Origin должны быть из списка.

Без этого любой открытый в браузере сайт подключается к ws://127.0.0.1:8780/ws (WebSocket
не подчиняется CORS) и шлёт ордера, а через DNS rebinding читает API.
Свои адреса (LAN, домен) — через ALLOWED_HOSTS=host1,host2.
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

LOCAL = {"127.0.0.1", "localhost", "::1"}


def allowed_hosts() -> set[str]:
    extra = {h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()}
    return LOCAL | extra


def _hostname(value: str) -> str:
    return (urlsplit("//" + value).hostname or "").lower()


def allowed(host: str, origin: str | None) -> bool:
    hosts = allowed_hosts()
    if _hostname(host) not in hosts:
        return False
    if origin is None:  # не браузер (curl, скрипт) — CSRF так не делают
        return True
    return (urlsplit(origin).hostname or "").lower() in hosts


class LocalOnly:
    """ASGI-обёртка: HTTP и WebSocket (обычный http-middleware Starlette сокеты не видит)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            if not allowed(headers.get("host", ""), headers.get("origin")):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
                await send({"type": "http.response.body", "body": "доступ только с локального адреса".encode()})
                return
        await self.app(scope, receive, send)
