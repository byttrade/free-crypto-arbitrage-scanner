"""Котировки через bytx — как live.py и examples/03_arbitrage_scanner.py."""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from bytx import create_exchange, errors
from bytx.testing import EXCHANGES

VENUE_LABEL = {
    "binance": "Binance",
    "bybit": "Bybit",
    "okx": "OKX",
    "bingx": "BingX",
    "kucoin": "KuCoin",
    "hyperliquid": "Hyperliquid",
    "bitget": "Bitget",
    "gate": "Gate",
    "mexc": "MEXC",
    "htx": "HTX",
    "blofin": "BloFin",
}

perp: dict[str, Any] = {}
spot: dict[str, Any] = {}
fund_ex: dict[str, Any] = {}
quotes: dict[str, dict] = {}
funding: dict[str, dict] = {}
status: dict[str, str | None] = {}


def proxy_for(venue: str) -> str | None:
    """Прокси биржи из env: BLOFIN_PROXY=http://host:port (BloFin режется частью провайдеров)."""
    return os.environ.get(f"{venue.upper()}_PROXY") or None


def _key(venue: str, kind: str, symbol: str) -> str:
    return f"{venue}|{kind}|{symbol}"


def _interval_hours(raw: dict) -> float | None:
    """Период фандинга в часах из ответа bytx. Нет поля — None, не выдумываем 8ч."""
    if not isinstance(raw, dict):
        return None
    found = _parse_hours(raw.get("interval"))
    if found:
        return found
    info = raw.get("info")
    if isinstance(info, dict):
        for key in (
            "fundingIntervalHours", "fundingIntervalHour", "fundingRateInterval",
            "fundingInterval", "collectCycle", "ratePeriod",
        ):
            found = _parse_hours(info.get(key))
            if found:
                return found
    return None


def _parse_hours(value: object) -> float | None:
    if value is None or value is False:
        return None
    text = str(value).strip().lower()
    if text.endswith("h"):
        text = text[:-1]
    try:
        hours = float(text)
    except ValueError:
        return None
    if hours >= 3_600_000:
        hours /= 3_600_000
    elif hours > 24:
        hours /= 60
    if hours < 0.5 or hours > 24:
        return None
    return hours


def _parts(symbol: str) -> tuple[str, str]:
    base, rest = symbol.split("/", 1)
    return base, rest.split(":")[0]


def _kind(symbol: str) -> str:
    return "perp" if ":" in symbol else "spot"


def _num(v) -> float:
    try:
        n = float(v)
        return n if n == n else 0.0
    except (TypeError, ValueError):
        return 0.0


def all_quotes() -> list[dict]:
    return list(quotes.values())


def funding_map() -> dict[str, dict]:
    return funding


def adapter_status() -> list[dict]:
    rows = []
    for name in EXCHANGES:
        for kind in ("perp", "spot"):
            tag = f"{name}:{kind}"
            if kind == "spot" and name not in spot and tag not in status:
                continue
            ok = _last_ok.get(tag)
            rows.append({"venue": name, "kind": kind, "error": status.get(tag),
                         "ageSec": round(time.time() - ok[0]) if ok else None, "count": ok[1] if ok else 0})
    return rows


def client(venue: str, kind: str):
    return (spot if kind == "spot" else perp).get(venue)


def open_clients() -> None:
    for name in EXCHANGES:
        proxy = proxy_for(name)
        perp[name] = create_exchange(name, proxy=proxy)
        # Полный список ставок у Gate занимает больше 10 с, общий клиент котировок такой вызов обрезает.
        fund_ex[name] = create_exchange(name, timeout=45, retries=0, proxy=proxy)
        status[f"{name}:perp"] = None
        try:
            spot[name] = create_exchange(name, market="spot", proxy=proxy)
            status[f"{name}:spot"] = None
        except Exception as e:
            status[f"{name}:spot"] = str(e)[:200]


async def close_clients() -> None:
    for t in [*_pollers, *_live.values()]:
        t.cancel()
    clients = list(perp.values()) + list(spot.values()) + list(fund_ex.values())
    await asyncio.gather(*(ex.close() for ex in clients), return_exceptions=True)


async def _list_tickers(ex) -> list:
    rows = await ex.tickers()
    if isinstance(rows, dict):
        return list(rows.values())
    return list(rows or [])


_active: dict[str, tuple[float, set[str]]] = {}
_taker: dict[str, float] = {}
# Базовые taker-комиссии, если биржа не дала свою для рынка (доли, не проценты).
TAKER_DEFAULT = {"perp": 0.0006, "spot": 0.001}


def taker(venue: str, kind: str, symbol: str) -> float:
    return _taker.get(_key(venue, kind, symbol), TAKER_DEFAULT.get(kind, 0.001))
ACTIVE_TTL = 3600


async def _active_symbols(tag: str, ex) -> set[str] | None:
    """Активные рынки биржи раз в час. Нет списка — не фильтруем (лучше лишняя строка, чем пустая таблица)."""
    hit = _active.get(tag)
    if hit and time.time() - hit[0] < ACTIVE_TTL:
        return hit[1]
    try:
        if hit:  # список рынков у ccxt кэшируется при подключении — делистинг виден только после перезагрузки
            await ex.reload_markets()
        rows = await ex.markets(active_only=True)
    except Exception:
        return hit[1] if hit else None
    found = {m.symbol for m in rows}
    _active[tag] = (time.time(), found)
    name, kind = tag.split(":", 1)
    for m in rows:
        fee = getattr(m, "taker_fee", None)
        if fee is not None:
            _taker[_key(name, kind, m.symbol)] = float(fee)
    return found


async def _poll_one(name: str, kind: str, ex) -> None:
    tag = f"{name}:{kind}"
    try:
        active = await _active_symbols(tag, ex)
        tickers = await _list_tickers(ex)
        seen = time.time()
        n = 0
        for t in tickers:
            symbol = getattr(t, "symbol", "") or ""
            if "/" not in symbol:
                continue
            k = _kind(symbol)
            if k != kind:
                continue
            if k == "perp" and not (symbol.endswith(":USDT") or symbol.endswith(":USDC")):
                continue
            base, quote = _parts(symbol)
            if quote not in ("USDT", "USDC"):
                continue
            if active is not None and symbol not in active:
                continue
            last = _num(t.last) or ((_num(t.bid) + _num(t.ask)) / 2 if t.bid and t.ask else 0)
            if last <= 0:
                continue
            bid = _num(t.bid) or last
            ask = _num(t.ask) or last
            vol = _num(t.quote_volume) or _num(t.base_volume) * last
            key = _key(name, kind, symbol)
            prev = quotes.get(key)
            if prev and prev.get("ws") and seen - prev["seen"] < 5:
                prev.update(last=last, volumeUsd=_num(t.quote_volume) or _num(t.base_volume) * last)
                n += 1
                continue
            quotes[key] = {
                "venue": name,
                "kind": kind,
                "symbol": symbol,
                "base": base,
                "quote": quote,
                "bid": bid,
                "ask": ask,
                "last": last,
                "volumeUsd": vol,
                # Не все биржи ставят время в тикер: тогда время получения.
                "ts": int(t.timestamp or 0) or int(seen * 1000),
                "seen": seen,
            }
            n += 1
        if n:
            status[tag] = None
            _last_ok[tag] = (seen, n)
    except errors.BytxError as e:
        status[tag] = str(e)[:200]
    except Exception as e:
        status[tag] = str(e)[:200]


_last_ok: dict[str, tuple[float, int]] = {}
_pollers: list[asyncio.Task] = []
# Пауза между снимками тикеров. Binance (вес 40/80 за весь рынок) и Hyperliquid (вес 20) — реже, чтобы не упереться в лимиты.
POLL_GAP = {"binance": 3.0, "hyperliquid": 3.0}
POLL_GAP_DEFAULT = 1.5
FIRST_POLL_SEC = 90  # первое подключение грузит рынки: у Gate это до ~40 с


async def _within(coro, seconds: float = 8) -> bool:
    try:
        await asyncio.wait_for(coro, seconds)
        return True
    except asyncio.CancelledError:
        # ccxt/aiohttp отменяют свои запросы изнутри — это сбой одной биржи, а не остановка сервера.
        if asyncio.current_task().cancelling():
            raise
    except Exception:
        pass
    return False


async def _poller(name: str, kind: str, ex) -> None:
    """Свой цикл на каждую биржу: медленная биржа не задерживает остальные."""
    tag = f"{name}:{kind}"
    first = True
    while True:
        limit = FIRST_POLL_SEC if first or tag not in _last_ok else 10
        if not await _within(_poll_one(name, kind, ex), limit) and status.get(tag) is None:
            status[tag] = f"нет ответа за {limit} с"
        first = False
        gap = POLL_GAP.get(name, POLL_GAP_DEFAULT)
        await asyncio.sleep(gap if status.get(tag) is None else max(gap, 15))


def start_pollers() -> None:
    for name, ex in perp.items():
        _pollers.append(asyncio.create_task(_poller(name, "perp", ex)))
    for name, ex in spot.items():
        _pollers.append(asyncio.create_task(_poller(name, "spot", ex)))


_rate_cursor: dict[str, int] = {}
_interval_mode: dict[str, str] = {}
_interval_fail: dict[str, int] = {}
_batch_ok: set[str] = set()
RATE_CHUNK = 40
INTERVAL_CHUNK = 40


def _quote_symbol(name: str, symbol: str) -> str:
    if _key(name, "perp", symbol) in quotes:
        return symbol
    if ":" not in symbol:
        for settle in (":USDT", ":USDC"):
            if _key(name, "perp", symbol + settle) in quotes:
                return symbol + settle
    return symbol


def _save_rate(name: str, row) -> None:
    symbol = _quote_symbol(name, getattr(row, "symbol", "") or "")
    if not symbol:
        return
    key = _key(name, "perp", symbol)
    prev = funding.get(key) or {}
    hours = _interval_hours(getattr(row, "raw", None) or {})
    funding[key] = {
        "rate": _num(row.rate) * 100,
        "intervalH": hours if hours is not None else prev.get("intervalH"),
        "mark": _num(row.mark_price) or prev.get("mark") or 0,
        "index": _num(row.index_price) or prev.get("index"),
        "ts": int(row.timestamp or 0),
        "next": int(getattr(row, "next_funding_time", 0) or 0) or prev.get("next"),
    }


def _perp_symbols(name: str) -> list[str]:
    return [q["symbol"] for q in quotes.values() if q["venue"] == name and q["kind"] == "perp"]


def _chunk(name: str, symbols: list[str], size: int) -> list[str]:
    if not symbols:
        return []
    start = _rate_cursor.get(name, 0) % len(symbols)
    picked = [symbols[(start + i) % len(symbols)] for i in range(min(size, len(symbols)))]
    _rate_cursor[name] = (start + len(picked)) % len(symbols)
    return picked


async def _rates(ex, symbols: list[str]):
    async def one(symbol: str):
        try:
            return await ex.funding_rate(symbol)
        except (errors.BytxError, Exception):
            return None

    rows = await asyncio.gather(*(one(symbol) for symbol in symbols))
    return [row for row in rows if row]


async def _fill_intervals(name: str, ex) -> None:
    """Один запрос пачки периодов. Binance отдаёт их отдельно от ставки, без этого в таблице тире.
    У остальных бирж период приходит со ставкой: повторный запрос ставок ничего не добавит."""
    if name != "binance":
        return
    try:
        intervals = await ex.funding_intervals()
    except (errors.BytxError, Exception):
        return
    for raw_symbol, hours in intervals.items():
        symbol = _quote_symbol(name, raw_symbol)
        key = _key(name, "perp", symbol)
        if hours and key in funding and not funding[key].get("intervalH"):
            funding[key]["intervalH"] = hours


async def _history_hours(ex, symbol: str) -> float | None:
    try:
        rows = await ex.funding_history(symbol, limit=3)
    except (errors.BytxError, Exception):
        return None
    stamps = sorted({int(row.timestamp) for row in rows if getattr(row, "timestamp", None)})
    if len(stamps) < 2:
        return None
    return _parse_hours((stamps[-1] - stamps[-2]) / 3_600_000)


async def poll_funding() -> None:
    """Сначала общая пачка. Если биржа просит список символов — берём свои перпы порциями.
    Период, которого нет в пачке, добираем точечно: из funding_rate, иначе из истории выплат."""

    async def one(name, ex):
        symbols = _perp_symbols(name)
        try:
            batch = await ex.funding_rates()
        except errors.NotSupported:
            batch = None
        except (errors.BytxError, Exception):
            batch = None
        if batch:
            _batch_ok.add(name)
            rows = batch.values() if isinstance(batch, dict) else batch
            for row in rows or []:
                _save_rate(name, row)
        elif symbols and name not in _batch_ok:
            for row in await _rates(ex, _chunk(name, symbols, RATE_CHUNK)):
                _save_rate(name, row)
        # Пачка часто неполная: KuCoin и OKX не отдают все перпы. Добираем пропуски.
        if symbols:
            absent = [symbol for symbol in symbols if _key(name, "perp", symbol) not in funding]
            if absent:
                for row in await _rates(ex, _chunk(name + ":gap", absent, RATE_CHUNK)):
                    _save_rate(name, row)

        if symbols and any(not (funding.get(_key(name, "perp", symbol)) or {}).get("intervalH") for symbol in symbols):
            await _fill_intervals(name, ex)

        missing = []
        for symbol in symbols:
            key = _key(name, "perp", symbol)
            row = funding.get(key)
            if not row or row.get("intervalH"):
                continue
            missing.append(symbol)
        # Сначала крупные ставки: их видно на вкладке. Редкая ошибка не прячет их в конец очереди.
        missing.sort(key=lambda symbol: (
            -abs(funding[_key(name, "perp", symbol)]["rate"]),
            _interval_fail.get(_key(name, "perp", symbol), 0),
        ))
        if not missing:
            return
        chunk = missing[:INTERVAL_CHUNK]
        if _interval_mode.get(name) != "history":
            rows = await _rates(ex, chunk)
            found = False
            for row in rows:
                symbol = _quote_symbol(name, row.symbol)
                before = (funding.get(_key(name, "perp", symbol)) or {}).get("intervalH")
                _save_rate(name, row)
                if not before and (funding.get(_key(name, "perp", symbol)) or {}).get("intervalH"):
                    found = True
            # Пустой ответ — биржа не ответила, повторим. Ответ без периода — только история выплат.
            if rows and not found:
                _interval_mode[name] = "history"
        if _interval_mode.get(name) == "history":
            hours = await asyncio.gather(*(_history_hours(ex, symbol) for symbol in chunk))
            for symbol, value in zip(chunk, hours):
                key = _key(name, "perp", symbol)
                if value and key in funding:
                    funding[key]["intervalH"] = value
                elif key in funding:
                    _interval_fail[key] = _interval_fail.get(key, 0) + 1

    await asyncio.gather(*(one(n, ex) for n, ex in fund_ex.items()), return_exceptions=True)


def levels(book) -> tuple[list[dict], list[dict]]:
    def take(side):
        out = []
        for px, sz in (side or [])[:24]:
            if px and sz:
                out.append({"price": float(px), "size": float(sz)})
        return out

    return take(book.bids), take(book.asks)


async def load_book(venue: str, symbol: str, kind: str) -> dict | None:
    ex = client(venue, kind)
    if not ex:
        return None
    try:
        book = await ex.order_book(symbol, 40)
        bids, asks = levels(book)
        return {"venue": venue, "symbol": symbol, "bids": bids, "asks": asks, "ts": book.timestamp or 0}
    except errors.BytxError:
        return None


async def load_tape(venue: str, symbol: str, kind: str) -> list[dict]:
    ex = client(venue, kind)
    if not ex:
        return []
    try:
        trades = await ex.trades(symbol)
        out = []
        for t in trades or []:
            out.append({
                "venue": venue,
                "symbol": symbol,
                "ts": t.timestamp or 0,
                "price": float(t.price),
                "size": float(t.size),
                "side": t.side or "buy",
            })
        return out
    except errors.BytxError:
        return []


_feed: asyncio.Queue = asyncio.Queue(maxsize=400)
_watch_tasks: dict[str, asyncio.Task] = {}


def book_feed() -> asyncio.Queue:
    return _feed


async def _put(item: dict) -> None:
    if _feed.full():
        try:
            _feed.get_nowait()
        except asyncio.QueueEmpty:
            pass
    await _feed.put(item)


def _trade(t, venue: str, symbol: str) -> dict:
    return {
        "venue": venue,
        "symbol": symbol,
        "ts": int(getattr(t, "timestamp", 0) or 0) or int(__import__("time").time() * 1000),
        "price": float(t.price),
        "size": float(t.size),
        "side": t.side or "buy",
    }


async def _push_rest(venue: str, symbol: str, kind: str) -> None:
    book = await load_book(venue, symbol, kind)
    if book:
        book["ts"] = int(__import__("time").time() * 1000)
        await _put({"type": "book", "book": book})
    tape = await load_tape(venue, symbol, kind)
    if tape:
        await _put({"type": "tape", "venue": venue, "symbol": symbol, "trades": tape})


WS_STALE_SEC = 3.0


async def _run_watch(key: str, spec: dict) -> None:
    """Стакан и лента — по WS. REST только пока WS молчит (нет потока у биржи, обрыв, переподключение)."""
    venue, symbol = spec["venue"], spec["symbol"]
    kind = spec.get("kind") or "perp"
    ex = client(venue, kind)
    if not ex:
        return
    last = {"book": 0.0, "tape": 0.0}

    async def books() -> None:
        try:
            async for book in ex.stream.order_book(symbol, depth=20):
                last["book"] = time.time()
                bids, asks = levels(book)
                await _put({
                    "type": "book",
                    "book": {"venue": venue, "symbol": symbol, "bids": bids, "asks": asks,
                             "ts": int(last["book"] * 1000)},  # время получения: часы биржи и Docker могут расходиться
                })
        except Exception:
            last["book"] = 0.0  # поток упал — дальше живём на REST

    async def tapes() -> None:
        stream = getattr(ex.stream, "trades", None)
        if stream is None:
            return
        try:
            async for t in stream(symbol):
                last["tape"] = time.time()
                await _put({"type": "tape", "venue": venue, "symbol": symbol, "trades": [_trade(t, venue, symbol)]})
        except Exception:
            last["tape"] = 0.0

    async def rest_fallback() -> None:
        # Первый снимок сразу (история ленты, стакан до первого WS-сообщения), дальше — только при тишине WS.
        await _push_rest(venue, symbol, kind)
        while True:
            await asyncio.sleep(1)
            now = time.time()
            if now - last["book"] > WS_STALE_SEC:
                book = await load_book(venue, symbol, kind)
                if book and time.time() - last["book"] > WS_STALE_SEC:
                    book["ts"] = int(time.time() * 1000)
                    await _put({"type": "book", "book": book})
            if now - last["tape"] > WS_STALE_SEC * 2:
                tape = await load_tape(venue, symbol, kind)
                if tape and time.time() - last["tape"] > WS_STALE_SEC * 2:
                    await _put({"type": "tape", "venue": venue, "symbol": symbol, "trades": tape})

    try:
        await asyncio.gather(books(), tapes(), rest_fallback())
    except asyncio.CancelledError:
        return


# Живые лучшие цены по WS для строк, которые видит пользователь. Весь рынок по WS bytx не отдаёт
# (поток только по одному символу) — общий скрин остаётся на REST-снимках.
LIVE_MAX = 120
LIVE_HOLD_SEC = 60  # строка выпала из топа — держим подписку минуту, чтобы не дёргать биржу
_live: dict[str, asyncio.Task] = {}
_live_want: dict[str, float] = {}
live_stats = {"updates": 0}


async def _run_live(key: str, venue: str, kind: str, symbol: str) -> None:
    ex = client(venue, kind)
    if not ex:
        return
    try:
        async for t in ex.stream.best_bid_ask(symbol):
            q = quotes.get(key)
            bid, ask = _num(t.bid), _num(t.ask)
            if not q or bid <= 0 or ask <= 0 or bid > ask:
                continue
            now = time.time()
            q.update(bid=bid, ask=ask, seen=now, ts=int(t.timestamp or now * 1000), ws=True)
            live_stats["updates"] += 1
    except asyncio.CancelledError:
        raise
    except Exception:
        return  # нет потока у биржи — строка живёт на REST-снимках


def live_info() -> dict:
    return {"subs": len(_live), "running": sum(not t.done() for t in _live.values()), **live_stats}


def sync_live(legs: list[tuple[str, str, str]]) -> None:
    now = time.time()
    for venue, kind, symbol in legs[:LIVE_MAX]:
        _live_want[_key(venue, kind, symbol)] = now
    for key, at in list(_live_want.items()):
        if now - at > LIVE_HOLD_SEC:
            _live_want.pop(key)
    for key in list(_live):
        if key not in _live_want or _live[key].done():
            _live.pop(key).cancel()
    for key in sorted(_live_want, key=lambda k: -_live_want[k]):
        if len(_live) >= LIVE_MAX:
            break
        if key not in _live and key in quotes:
            venue, kind, symbol = key.split("|", 2)
            _live[key] = asyncio.create_task(_run_live(key, venue, kind, symbol))


def sync_watch(items: list[dict]) -> None:
    wanted: dict[str, dict] = {}
    for b in items:
        if not b.get("venue") or not b.get("symbol"):
            continue
        kind = b.get("kind") or "perp"
        wanted[f"{b['venue']}|{kind}|{b['symbol']}"] = {**b, "kind": kind}
    for key in list(_watch_tasks):
        if key not in wanted:
            _watch_tasks.pop(key).cancel()
    for key, spec in wanted.items():
        task = _watch_tasks.get(key)
        if task is None or task.done():
            _watch_tasks[key] = asyncio.create_task(_run_watch(key, spec))


async def load_candles(venue: str, symbol: str, kind: str, tf="4h", limit=500) -> list[tuple[int, float]]:
    rows = await load_ohlc(venue, symbol, kind, tf, limit)
    return [(row["t"], row["c"]) for row in rows]


def _bars(rows) -> list[dict]:
    out = []
    for c in rows or []:
        if not c.timestamp or not c.close:
            continue
        out.append({
            "t": int(c.timestamp),
            "o": float(c.open),
            "h": float(c.high),
            "l": float(c.low),
            "c": float(c.close),
        })
    return out


async def load_ohlc(
    venue: str, symbol: str, kind: str, tf: str, limit: int,
    since: int | None = None, until: int | None = None,
) -> list[dict]:
    ex = client(venue, kind)
    if not ex:
        return []
    try:
        # Blofin и похожие биржи листают историю только через until, since даёт ту же последнюю страницу.
        rows = await ex.candles(symbol, tf, since=since, limit=limit, until=until or None)
    except errors.BytxError:
        if until:
            return await load_ohlc(venue, symbol, kind, tf, limit, since, None)
        return []
    out = _bars(rows)
    if until and (not out or out[0]["t"] > until):
        return await load_ohlc(venue, symbol, kind, tf, limit, since, None)
    return out


def liquid_bases(min_volume: float, quote="USDT") -> list[dict]:
    best: dict[str, dict] = {}
    for q in quotes.values():
        if q["kind"] != "perp" or q["quote"] != quote or q["volumeUsd"] < min_volume:
            continue
        prev = best.get(q["base"])
        if not prev or q["volumeUsd"] > prev["volumeUsd"]:
            best[q["base"]] = q
    return sorted(best.values(), key=lambda x: -x["volumeUsd"])
