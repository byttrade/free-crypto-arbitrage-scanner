"""Ввод и вывод монет для спотового арбитража: купили на A — надо вывести с A и завести на B.

Без API-ключей статус отдают не все биржи (из проверенных: KuCoin, Bitget, HTX, Gate).
Остальные помечаются как «неизвестно».
"""
from __future__ import annotations

import asyncio
import time

from .market import spot

REFRESH_SEC = 30 * 60
_state: dict[str, dict[str, tuple[bool | None, bool | None]]] = {}  # venue → монета → (ввод, вывод)
_at: dict[str, float] = {}


def _flags(cur: dict) -> tuple[bool | None, bool | None]:
    dep, wd = cur.get("deposit"), cur.get("withdraw")
    nets = (cur.get("networks") or {}).values()
    # Монета открыта, если открыта хоть одна сеть; биржа без данных по сетям — берём общий флаг.
    if nets:
        dep = any(n.get("deposit") for n in nets) if any(n.get("deposit") is not None for n in nets) else dep
        wd = any(n.get("withdraw") for n in nets) if any(n.get("withdraw") is not None for n in nets) else wd
    return dep, wd


async def _load(venue: str, ex) -> None:
    try:
        # shortcut: в bytx нет метода валют и сетей (ТЗ bytx, п. 12) — берём ccxt через ex.ccxt.
        cur = await asyncio.wait_for(ex.ccxt.fetch_currencies(), 60)
    except Exception:
        return
    if cur:
        _state[venue] = {code: _flags(c or {}) for code, c in cur.items()}
    _at[venue] = time.time()


async def poll() -> None:
    now = time.time()
    due = [(v, ex) for v, ex in spot.items() if now - _at.get(v, 0) > REFRESH_SEC]
    await asyncio.gather(*(_load(v, ex) for v, ex in due), return_exceptions=True)


def status(buy_venue: str, sell_venue: str, base: str) -> tuple[str, str, str]:
    """(ok|blocked|unknown, withdraw|deposit|"", биржа). Нужен вывод с биржи покупки и ввод на биржу продажи."""
    out = _state.get(buy_venue, {}).get(base)
    inn = _state.get(sell_venue, {}).get(base)
    if out and out[1] is False:
        return "blocked", "withdraw", buy_venue
    if inn and inn[0] is False:
        return "blocked", "deposit", sell_venue
    if out and inn and out[1] and inn[0]:
        return "ok", "", ""
    return "unknown", "", ""


def annotate(rows: list[dict]) -> None:
    for r in rows:
        if r["kind"] == "spot":
            r["transfer"], r["transferWhy"], r["transferVenue"] = status(r["buyVenue"], r["sellVenue"], r["base"])


def info() -> dict:
    return {v: len(s) for v, s in _state.items()}
