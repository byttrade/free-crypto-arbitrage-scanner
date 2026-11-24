"""Кто может обращаться к панели.

1. Чужие сайты — никогда: Origin должен совпадать с адресом панели. Без этого любой открытый в браузере сайт
   подключается к ws://127.0.0.1:8780/ws (WebSocket не подчиняется CORS) и шлёт ордера.
2. Есть учётная запись (auth.json) — API и сокет только после входа, с любого адреса (свой сервер, домен, LAN).
3. Учётной записи нет — как раньше, только локально: Host из списка (защита от DNS rebinding);
   свои адреса — ALLOWED_HOSTS=host1,host2. В публичном режиме без учётной записи данные не отдаются вовсе.
Статика интерфейса (страница, скрипты, логотипы) и /api/auth/* открыты: на них нет данных.
"""
from __future__ import annotations

import os
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from . import auth

LOCAL = {"127.0.0.1", "localhost", "::1"}


def allowed_hosts() -> set[str]:
    extra = {h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()}
    return LOCAL | extra


def _hostname(value: str) -> str:
    return (urlsplit("//" + value).hostname or "").lower()


def local_host(host: str) -> bool:
    return _hostname(host) in allowed_hosts()


def allowed(host: str, origin: str | None) -> bool:
    """Локальный режим: Host из списка, Origin (если есть) тоже."""
    hosts = allowed_hosts()
    if _hostname(host) not in hosts:
        return False
    if origin is None:  # не браузер (curl, скрипт) — CSRF так не делают
        return True
    return (urlsplit(origin).hostname or "").lower() in hosts


def same_origin(host: str, origin: str | None) -> bool:
    if origin is None:
        return True
    o = urlsplit(origin)
    if o.netloc.lower() == host.lower():
        return True
    return local_host(host) and (o.hostname or "").lower() in allowed_hosts()  # Vite dev: localhost:5173 -> :8780


def cookie_of(header: str | None) -> str | None:
    if not header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    return jar[auth.COOKIE].value if auth.COOKIE in jar else None


def verdict(path: str, host: str, origin: str | None, cookie: str | None) -> tuple[int, str] | None:
    """None — пропустить; иначе (код, текст)."""
    if not same_origin(host, origin):
        return 403, "запрос с чужого сайта"
    if not (path.startswith("/api/") or path == "/ws") or path.startswith("/api/auth/"):
        return None
    if auth.account():
        return None if auth.session_user(cookie) else (401, "нужен вход")
    if auth.public:
        return 403, "сначала создайте учётную запись по ссылке из терминала сервера"
    return None if allowed(host, origin) else (403, "доступ только с локального адреса — или создайте учётную запись")


class Gate:
    """ASGI-обёртка: HTTP и WebSocket (обычный http-middleware Starlette сокеты не видит)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            bad = verdict(scope.get("path", ""), headers.get("host", ""), headers.get("origin"), cookie_of(headers.get("cookie")))
            if bad:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4401 if bad[0] == 401 else 1008})
                    return
                await send({"type": "http.response.start", "status": bad[0],
                            "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
                await send({"type": "http.response.body", "body": bad[1].encode()})
                return
        await self.app(scope, receive, send)
