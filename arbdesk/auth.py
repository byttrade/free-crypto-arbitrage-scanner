"""Логин и пароль панели: доступ извне (свой сервер, домашний компьютер) и защита от чужих сайтов.

- Учётная запись одна: DATA_DIR/auth.json (права 600), пароль — scrypt с солью, сам пароль нигде не хранится.
- Вход — подписанная cookie (HMAC, 30 дней, HttpOnly, SameSite=Strict, Secure на HTTPS). Ключ подписи лежит
  в auth.json; сброс пароля меняет ключ — все входы на всех устройствах сбрасываются.
- Подбор пароля: после 5 ошибок с одного адреса — пауза, растущая до часа.
- Без учётной записи панель работает как раньше: только с локального адреса (Host из guard.allowed_hosts).
  В публичном режиме (--public) без учётной записи наружу не отдаётся ничего, кроме формы создания, и создать её
  можно только по одноразовой ссылке, которую сервер печатает в свой терминал / лог.
- Сброс пароля — только из терминала сервера: `arbdesk reset-password`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from . import settings

COOKIE = "arbdesk_session"
TTL = 30 * 24 * 3600
MIN_PASSWORD = 8
USER_RE = re.compile(r"^[\w.@-]{3,40}$")
_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}

public = os.environ.get("ARBDESK_PUBLIC", "").lower() in ("1", "true", "yes", "on")
setup_token: str | None = None   # одноразовый код создания учётной записи (публичный режим, пока её нет)

_cache: tuple[float, dict | None] = (-1.0, None)
_fails: dict[str, tuple[int, float]] = {}  # ip -> (ошибок подряд, до какого времени пауза)


def _file() -> Path:
    return settings.DATA_DIR / "auth.json"


def account() -> dict | None:
    """Учётная запись или None. Файл перечитывается при изменении (сброс пароля из терминала)."""
    global _cache
    f = _file()
    try:
        mtime = f.stat().st_mtime
    except OSError:
        _cache = (-1.0, None)
        return None
    if mtime != _cache[0]:
        try:
            _cache = (mtime, json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            _cache = (mtime, None)
    return _cache[1]


def _hash(password: str, salt: bytes) -> str:
    return base64.b64encode(hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)).decode()


def validate(user: str, password: str) -> None:
    if not USER_RE.match(user or ""):
        raise ValueError("логин: 3–40 символов, буквы, цифры, . _ @ -")
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"пароль: не короче {MIN_PASSWORD} символов")


def save_account(user: str, password: str) -> None:
    """Создать или заменить учётную запись. Новый ключ подписи: прежние входы перестают действовать."""
    global setup_token
    validate(user, password)
    salt = os.urandom(16)
    data = {"user": user, "salt": base64.b64encode(salt).decode(), "hash": _hash(password, salt),
            "key": secrets.token_hex(32), "created": int(time.time())}
    f = _file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(f)
    setup_token = None


def check_password(user: str, password: str) -> bool:
    acc = account()
    if not acc:
        return False
    got = _hash(password or "", base64.b64decode(acc["salt"]))
    return hmac.compare_digest(got, acc["hash"]) and hmac.compare_digest((user or "").encode(), acc["user"].encode())


def make_cookie(now: float | None = None) -> str:
    acc = account()
    exp = int((time.time() if now is None else now) + TTL)
    body = f"{acc['user']}.{exp}"
    sig = hmac.new(acc["key"].encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def session_user(cookie: str | None, now: float | None = None) -> str | None:
    acc = account()
    if not acc or not cookie:
        return None
    try:
        user, exp, sig = cookie.rsplit(".", 2)
        exp_i = int(exp)
    except ValueError:
        return None
    want = hmac.new(acc["key"].encode(), f"{user}.{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, want) or user != acc["user"] or exp_i < (time.time() if now is None else now):
        return None
    return user


def throttled(ip: str, now: float | None = None) -> int:
    """Сколько секунд ждать этому адресу до следующей попытки входа (0 — можно)."""
    n, until = _fails.get(ip, (0, 0.0))
    return max(0, int(until - (time.time() if now is None else now)))


def failed(ip: str, now: float | None = None) -> None:
    now = time.time() if now is None else now
    n = _fails.get(ip, (0, 0.0))[0] + 1
    _fails[ip] = (n, now + (min(3600, 60 * 2 ** (n - 5)) if n >= 5 else 0))


def succeeded(ip: str) -> None:
    _fails.pop(ip, None)


def new_setup_token() -> str:
    global setup_token
    setup_token = secrets.token_urlsafe(18)
    return setup_token


def setup_allowed(token: str | None, local_host: bool) -> bool:
    """Создать учётную запись можно, пока её нет: локально — сразу, в публичном режиме — только по коду."""
    if account():
        return False
    if public:
        return bool(setup_token and token and hmac.compare_digest(token, setup_token))
    return local_host
