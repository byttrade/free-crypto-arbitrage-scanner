"""Спред на объём: проходим по стакану на sizeUsd, а не смотрим только лучшие цены.

Стаканы берём REST-снимком (глубина 20) для верхних строк таблицы и кэшируем на несколько секунд.
"""
from __future__ import annotations

import asyncio
import time

from bytx import errors

from . import settings
from .market import client

BOOK_TTL = 8.0
TOP_ROWS = 40
_books: dict[str, tuple[float, list, list]] = {}  # key → (время, asks, bids) как [(цена, размер)]
_busy: set[str] = set()
_sem = asyncio.Semaphore(8)


def _key(venue: str, kind: str, symbol: str) -> str:
    return f"{venue}|{kind}|{symbol}"


def buy_cost(asks: list, usd: float) -> tuple[float, float] | None:
    """Сколько монет купим на usd и по какой средней цене. None — в стакане не хватает объёма."""
    left, qty = usd, 0.0
    for px, sz in asks:
        take = min(left, px * sz)
        qty += take / px
        left -= take
        if left <= 1e-9:
            return qty, usd / qty
    return None


def sell_proceeds(bids: list, qty: float) -> float | None:
    left, got = qty, 0.0
    for px, sz in bids:
        take = min(left, sz)
        got += take * px
        left -= take
        if left <= 1e-12:
            return got
    return None


def exec_pct(asks: list, bids: list, usd: float) -> float | None:
    """Спред на объём: купить на usd по стакану покупки и продать то же число монет по стакану продажи."""
    bought = buy_cost(asks, usd)
    if not bought:
        return None
    got = sell_proceeds(bids, bought[0])
    if got is None:
        return None
    return (got - usd) / usd * 100


async def _load(venue: str, kind: str, symbol: str) -> None:
    key = _key(venue, kind, symbol)
    ex = client(venue, kind)
    if not ex or key in _busy:
        return
    _busy.add(key)
    try:
        async with _sem:
            book = await asyncio.wait_for(ex.order_book(symbol, 20), 6)
        asks = [(float(p), float(s)) for p, s in (book.asks or []) if p and s]
        bids = [(float(p), float(s)) for p, s in (book.bids or []) if p and s]
        _books[key] = (time.time(), asks, bids)
    except (errors.BytxError, asyncio.TimeoutError, Exception):
        pass
    finally:
        _busy.discard(key)


def refresh(rows: list[dict]) -> None:
    """Подгрузить устаревшие стаканы для верхних строк (фоном, не ждём)."""
    now = time.time()
    for r in rows[:TOP_ROWS]:
        for venue, symbol in ((r["buyVenue"], r["buySymbol"]), (r["sellVenue"], r["sellSymbol"])):
            hit = _books.get(_key(venue, r["kind"], symbol))
            if not hit or now - hit[0] > BOOK_TTL:
                asyncio.create_task(_load(venue, r["kind"], symbol))
    for key, (at, _a, _b) in list(_books.items()):
        if now - at > 120:
            _books.pop(key, None)


def annotate(rows: list[dict]) -> None:
    """Дописать в строки спред на объём там, где есть свежие стаканы обеих ног."""
    usd = float(settings.get()["sizeUsd"])
    now = time.time()
    for r in rows:
        buy = _books.get(_key(r["buyVenue"], r["kind"], r["buySymbol"]))
        sell = _books.get(_key(r["sellVenue"], r["kind"], r["sellSymbol"]))
        if not buy or not sell or now - buy[0] > BOOK_TTL * 3 or now - sell[0] > BOOK_TTL * 3:
            continue
        pct = exec_pct(buy[1], sell[2], usd)
        r["execPct"] = pct
        r["execNetPct"] = None if pct is None else pct - r["spreadPct"] + r["netPct"]
        r["execUsd"] = usd
