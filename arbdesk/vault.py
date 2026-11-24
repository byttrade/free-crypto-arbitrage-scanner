from __future__ import annotations

import base64
import json
import os
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

from bytx import create_exchange

from .market import proxy_for
from .settings import DATA_DIR

FILE = DATA_DIR / "vault.json"
STABLES = ("USDT", "USDC", "USD", "BUSD")

_rows: list[dict] = []
_salt: bytes = b""
_open: dict[str, dict] = {}
_usdt: dict[str, float] = {}


def _path() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return FILE


def load() -> None:
    global _rows, _salt
    path = _path()
    if not path.exists():
        _rows, _salt = [], os.urandom(16)
        return
    raw = json.loads(path.read_text(encoding="utf-8"))
    _salt = base64.b64decode(raw.get("salt") or "")
    if len(_salt) < 16:
        _salt = os.urandom(16)
    _rows = list(raw.get("keys") or [])


def _save() -> None:
    _path().write_text(
        json.dumps({"salt": base64.b64encode(_salt).decode(), "keys": _rows}, indent=2),
        encoding="utf-8",
    )


def _key(secret: str) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=_salt, iterations=120_000)
    return kdf.derive(secret.encode())


def _seal(secret: str, payload: dict) -> str:
    nonce = os.urandom(12)
    blob = AESGCM(_key(secret)).encrypt(nonce, json.dumps(payload).encode(), None)
    return base64.b64encode(nonce + blob).decode()


def _open_blob(secret: str, packed: str) -> dict:
    raw = base64.b64decode(packed)
    plain = AESGCM(_key(secret)).decrypt(raw[:12], raw[12:], None)
    return json.loads(plain.decode())


def opened() -> list[dict]:
    """Открытые ключи. Нужны торговому сокету, в браузер не отдаются."""
    out = []
    for row in _rows:
        creds = _open.get(row["id"])
        if not creds:
            continue
        out.append({
            "id": row["id"],
            "venue": row["venue"],
            "demo": bool(row.get("demo")),
            "apiKey": creds["apiKey"],
            "secret": creds["secret"],
            "password": creds.get("password") or "",
        })
    return out


def public() -> list[dict]:
    out = []
    for row in _rows:
        out.append({
            "id": row["id"],
            "venue": row["venue"],
            "demo": bool(row.get("demo")),
            "locked": row["id"] not in _open,
            "usdt": _usdt.get(row["id"]),
        })
    return out


def add(venue: str, api_key: str, api_secret: str, password: str, vault_secret: str, demo: bool) -> dict:
    if not vault_secret or not api_key or not api_secret:
        raise ValueError("нужны ключ, секрет биржи и секрет шифрования")
    if _rows:
        try:
            _open_blob(vault_secret, _rows[0]["blob"])
        except Exception as exc:
            raise ValueError("секрет не подходит к уже сохранённым ключам") from exc
    row = {
        "id": uuid.uuid4().hex[:12],
        "venue": venue,
        "demo": bool(demo),
        "blob": _seal(vault_secret, {"apiKey": api_key, "secret": api_secret, "password": password or ""}),
    }
    _rows.append(row)
    _save()
    _open[row["id"]] = {"apiKey": api_key, "secret": api_secret, "password": password or ""}
    return {"id": row["id"], "venue": venue, "demo": bool(demo), "locked": False, "usdt": None}


def remove(key_id: str) -> None:
    global _rows
    _rows = [r for r in _rows if r["id"] != key_id]
    _open.pop(key_id, None)
    _usdt.pop(key_id, None)
    _save()


def handoff() -> dict:
    """Открытые ключи для нового процесса после самообновления (передаются через pipe, не через диск)."""
    return {"open": _open}


def restore(data: dict) -> bool:
    """Принять ключи от прежнего процесса; только для записей, которые есть в vault.json."""
    known = {r["id"] for r in _rows}
    got = {k: v for k, v in (data.get("open") or {}).items() if k in known and isinstance(v, dict)}
    _open.update(got)
    return bool(got)


def unlock(secret: str) -> None:
    opened: dict[str, dict] = {}
    for row in _rows:
        opened[row["id"]] = _open_blob(secret, row["blob"])
    _open.clear()
    _open.update(opened)


async def refresh() -> list[dict]:
    for row in _rows:
        creds = _open.get(row["id"])
        if not creds:
            continue
        ex = create_exchange(
            row["venue"],
            api_key=creds["apiKey"],
            secret=creds["secret"],
            password=creds["password"] or None,
            demo=bool(row.get("demo")),
            proxy=proxy_for(row["venue"]),
            timeout=8,
            retries=0,
        )
        try:
            bal = await ex.balance()
            free = 0.0
            for code in STABLES:
                item = bal.items.get(code)
                if item:
                    free += float(item.free or 0)
            _usdt[row["id"]] = round(free, 2)
        except Exception:
            _usdt[row["id"]] = None
        finally:
            await ex.close()
    return public()
