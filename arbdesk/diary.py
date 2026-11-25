"""Дневник трейдера: личные сделки (ручной ввод, импорт CSV, закрытые связки терминала) и отчёт по ним.

Сделка — закрытая или открытая позиция: вход, выход, объём, комиссии, фандинг. PnL считаем сами,
либо берём готовый из импорта (выгрузки «закрытый PnL» бирж), если поле pnl заполнено.
"""
from __future__ import annotations

import csv
import io
import json
import re
import time
import uuid
from datetime import datetime, timezone

from . import settings

MARKETS = ("spot", "perp", "margin", "option", "other")
QUOTES = ("USDT", "USDC", "FDUSD", "BUSD", "USD", "EUR", "BTC", "ETH")
MAX_TRADES = 50_000

_trades: list[dict] | None = None


def _file():
    return settings.DATA_DIR / "trades.json"


def trades() -> list[dict]:
    global _trades
    if _trades is None:
        try:
            _trades = json.loads(_file().read_text(encoding="utf-8"))
        except Exception:
            _trades = []
    return _trades


def _save() -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(trades(), ensure_ascii=False), encoding="utf-8")
    tmp.replace(_file())  # атомарно: при сбое записи история не обрежется


# ---------- проверка ввода (данные из браузера и чужих CSV — не доверяем) ----------

def _num(v, name: str, required: bool = False, positive: bool = False) -> float | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        if required:
            raise ValueError(f"нет поля {name}")
        return None
    if isinstance(v, str):
        s = v.strip().replace(" ", "").replace(" ", "")
        if "," in s and "." not in s:
            s = s.replace(",", ".")  # десятичная запятая
        s = s.replace(",", "")
        v = s
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name}: не число") from None
    if x != x or abs(x) == float("inf"):
        raise ValueError(f"{name}: не число")
    if positive and x <= 0:
        raise ValueError(f"{name}: должно быть больше 0")
    return x


def _time(v, name: str, required: bool = False) -> int | None:
    """Время в мс: ISO, 'YYYY-MM-DD HH:MM[:SS]', 'DD.MM.YYYY HH:MM', epoch в с или мс. Без зоны — UTC."""
    if v is None or (isinstance(v, str) and not v.strip()):
        if required:
            raise ValueError(f"нет поля {name}")
        return None
    if isinstance(v, (int, float)) or re.fullmatch(r"\d{9,13}(\.\d+)?", str(v).strip()):
        x = float(v)
        return int(x if x > 1e11 else x * 1000)
    s = str(v).strip().replace("T", " ").replace("Z", "+00:00").replace("/", "-")
    m = re.fullmatch(r"(\d{2})\.(\d{2})\.(\d{4})(.*)", s)
    if m:
        s = f"{m[3]}-{m[2]}-{m[1]}{m[4]}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise ValueError(f"{name}: не понимаю дату «{str(v)[:30]}»") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def split_symbol(sym: str) -> tuple[str, str]:
    s = sym.strip().upper().split(":")[0]
    s = re.sub(r"[-_](SWAP|PERP|SPOT|FUTURES?)$", "", s)
    parts = [p for p in re.split(r"[/\-_ ]", s) if p]
    if len(parts) >= 2:
        return parts[0], parts[1]
    for q in QUOTES:
        if s.endswith(q) and len(s) > len(q):
            return s[: -len(q)], q
    return s, ""


def _text(v, n: int) -> str:
    return str(v or "").strip()[:n]


def clean(raw: dict) -> dict:
    """Проверенная сделка. ValueError с понятным текстом — если что-то не так."""
    if not isinstance(raw, dict):
        raise ValueError("ожидается объект")
    base, quote = (_text(raw.get("base"), 24).upper(), _text(raw.get("quote"), 12).upper())
    if not base and raw.get("symbol"):
        base, quote = split_symbol(str(raw["symbol"]))
    if not base or len(base) > 24:
        raise ValueError("нет монеты (base или symbol)")
    side = _text(raw.get("side"), 10).lower()
    side = {"buy": "long", "long": "long", "лонг": "long", "покупка": "long",
            "sell": "short", "short": "short", "шорт": "short", "продажа": "short"}.get(side)
    if not side:
        raise ValueError("side: long или short")
    market = _text(raw.get("market"), 10).lower() or "spot"
    market = {"futures": "perp", "swap": "perp", "linear": "perp", "perpetual": "perp", "фьючерс": "perp"}.get(market, market)
    if market not in MARKETS:
        market = "other"
    t = {
        "id": _text(raw.get("id"), 40) or uuid.uuid4().hex[:12],
        "openedAt": _time(raw.get("openedAt"), "openedAt", required=True),
        "closedAt": _time(raw.get("closedAt"), "closedAt"),
        "venue": _text(raw.get("venue"), 24).lower(),
        "base": base,
        "quote": quote or "USDT",
        "market": market,
        "side": side,
        "qty": _num(raw.get("qty"), "qty", required=True, positive=True),
        "entry": _num(raw.get("entry"), "entry", required=True, positive=True),
        "exit": _num(raw.get("exit"), "exit", positive=True),
        "fees": _num(raw.get("fees"), "fees") or 0.0,
        "funding": _num(raw.get("funding"), "funding") or 0.0,
        "pnl": _num(raw.get("pnl"), "pnl"),
        "leverage": _num(raw.get("leverage"), "leverage", positive=True),
        "strategy": _text(raw.get("strategy"), 32).lower(),
        "tags": [_text(x, 24) for x in (raw.get("tags") or [])[:10] if _text(x, 24)]
        if isinstance(raw.get("tags"), list) else [x.strip()[:24] for x in str(raw.get("tags") or "").split(",") if x.strip()][:10],
        "note": _text(raw.get("note"), 2000),
        "source": raw.get("source") if raw.get("source") in ("manual", "csv") else "manual",
    }
    if t["closedAt"] is not None and t["exit"] is None and t["pnl"] is None:
        raise ValueError("закрытой сделке нужна цена выхода (exit) или итог (pnl)")
    if t["closedAt"] is None and (t["exit"] is not None or t["pnl"] is not None):
        t["closedAt"] = t["openedAt"]  # выход есть, а времени нет — считаем закрытой в момент входа
    if t["closedAt"] is not None and t["closedAt"] < t["openedAt"]:
        raise ValueError("закрытие раньше открытия")
    return t


# ---------- PnL ----------

def pnl(t: dict, mark: float | None = None) -> float | None:
    """Реализованный PnL закрытой сделки или нереализованный открытой (по mark). В валюте котировки."""
    if t.get("pnl") is not None:
        return t["pnl"]
    d = 1 if t["side"] == "long" else -1
    px = t.get("exit") if t.get("closedAt") is not None else mark
    if not px:
        return None
    return d * (px - t["entry"]) * t["qty"] - (t.get("fees") or 0) + (t.get("funding") or 0)


def _mark(t: dict) -> float | None:
    from .market import all_quotes

    best = None
    for q in all_quotes():
        if q["base"] == t["base"] and q["quote"] == t["quote"] and q.get("last"):
            kind_ok = q["kind"] == ("perp" if t["market"] == "perp" else "spot")
            if q["venue"] == t["venue"] and kind_ok:
                return q["last"]
            if kind_ok and best is None:
                best = q["last"]
    return best


def _pair_trades() -> list[dict]:
    """Закрытые связки терминала — тоже сделки дневника (только чтение)."""
    from . import arb_exec

    out = []
    for row in arb_exec.journal():
        if row.get("status") != "closed":
            continue
        p = arb_exec.pnl(row)
        if p["pnl"] is None:
            continue
        legs = {leg["role"]: leg for leg in row["legs"]}
        out.append({
            "id": f"pair:{row['id']}", "openedAt": row["ts"], "closedAt": row.get("closedAt") or row["ts"],
            "venue": f"{legs['buy']['venue']}→{legs['sell']['venue']}", "base": row["base"], "quote": row["quote"],
            "market": row["kind"], "side": "long", "qty": min(p["qtyBuy"], p["qtySell"]),
            "entry": legs["buy"].get("avg") or 0, "exit": (legs["buy"].get("exit") or {}).get("avg"),
            "fees": p["fees"], "funding": 0.0, "pnl": p["pnl"], "leverage": None, "strategy": "spread",
            "tags": (["demo"] if all(leg.get("demo") for leg in row["legs"]) else [])
            + (["approx"] if any((leg.get("exit") or {}).get("outside") for leg in row["legs"]) else []),
            "note": "exit ≈ market: closed outside ArbDesk" if any((leg.get("exit") or {}).get("outside") for leg in row["legs"]) else "",
            "source": "terminal",
        })
    return out


def all_trades() -> list[dict]:
    return trades() + _pair_trades()


# ---------- изменения ----------

def upsert(raw: dict) -> dict:
    t = clean(raw)
    if t["id"].startswith("pair:"):
        raise ValueError("связки терминала меняются только в журнале связок")
    rows = trades()
    i = next((k for k, x in enumerate(rows) if x["id"] == t["id"]), None)
    if i is None:
        if len(rows) >= MAX_TRADES:
            raise ValueError(f"в дневнике уже {MAX_TRADES} сделок")
        rows.append(t)
    else:
        t["source"] = rows[i].get("source", t["source"])
        rows[i] = t
    _save()
    return t


def delete(tid: str) -> bool:
    rows = trades()
    n = len(rows)
    rows[:] = [x for x in rows if x["id"] != tid]
    if len(rows) != n:
        _save()
    return len(rows) != n


# ---------- CSV ----------

ALIASES = {
    "openedAt": ("openedat", "opened", "open_time", "opentime", "open time", "entry_time", "entry time", "date", "time",
                 "created time", "created_time", "trade time", "trade_time", "datetime", "timestamp", "date(utc)",
                 "time(utc)", "дата", "время", "дата открытия", "открыта"),
    "closedAt": ("closedat", "closed", "close_time", "closetime", "close time", "exit_time", "exit time", "updated time",
                 "дата закрытия", "закрыта"),
    "venue": ("venue", "exchange", "биржа"),
    "symbol": ("symbol", "pair", "market symbol", "contract", "contracts", "instrument", "пара", "символ", "инструмент"),
    "base": ("base", "coin", "asset", "монета"),
    "quote": ("quote", "котировка"),
    "market": ("market", "type", "market type", "рынок", "тип"),
    "side": ("side", "direction", "position side", "направление", "сторона"),
    "qty": ("qty", "quantity", "amount", "size", "volume", "closed qty", "filled", "количество", "объём", "объем"),
    "entry": ("entry", "entry price", "entry_price", "open price", "open_price", "avg entry price", "price",
              "цена входа", "вход"),
    "exit": ("exit", "exit price", "exit_price", "close price", "close_price", "avg exit price", "цена выхода", "выход"),
    "fees": ("fees", "fee", "commission", "trading fee", "комиссия", "комиссии"),
    "funding": ("funding", "funding fee", "фандинг"),
    "pnl": ("pnl", "realized pnl", "realized_pnl", "closed p&l", "closed pnl", "profit", "net pnl", "прибыль", "pnl, usdt"),
    "leverage": ("leverage", "плечо"),
    "strategy": ("strategy", "setup", "стратегия"),
    "tags": ("tags", "теги"),
    "note": ("note", "notes", "comment", "заметка", "комментарий"),
}
_HEAD = {alias: field for field, names in ALIASES.items() for alias in names}
EXPORT_COLS = ["openedAt", "closedAt", "venue", "base", "quote", "market", "side", "qty", "entry", "exit",
               "fees", "funding", "pnl", "leverage", "strategy", "tags", "note"]


def _key(t: dict) -> tuple:
    return (t["openedAt"], t["venue"], t["base"], t["side"], round(t["qty"], 10), round(t["entry"], 10))


def import_csv(text: str) -> dict:
    """Добавить сделки из CSV. Повторный импорт того же файла дублей не создаёт."""
    text = text.lstrip("﻿")
    first = text.split("\n", 1)[0]
    delim = max((";", ",", "\t"), key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    head = next(reader, None)
    if not head:
        return {"added": 0, "skipped": 0, "errors": ["пустой файл"]}
    cols = [_HEAD.get(h.strip().lower().strip('"')) for h in head]
    if "qty" not in cols or "entry" not in cols or not ({"symbol", "base"} & set(cols)):
        return {"added": 0, "skipped": 0, "errors": [
            "не нашёл колонки: нужны дата, пара (symbol), side, qty, entry; см. шаблон CSV"]}
    have = {_key(t) for t in trades()}
    added, skipped, errors = [], 0, []
    for n, row in enumerate(reader, start=2):
        if not any(c.strip() for c in row):
            continue
        raw = {"source": "csv"}
        for c, v in zip(cols, row):
            if c and v.strip() and c not in raw:
                raw[c] = v
        try:
            t = clean(raw)
        except ValueError as exc:
            if len(errors) < 50:
                errors.append(f"строка {n}: {exc}")
            continue
        if _key(t) in have:
            skipped += 1
            continue
        have.add(_key(t))
        added.append(t)
    if len(trades()) + len(added) > MAX_TRADES:
        return {"added": 0, "skipped": skipped, "errors": [f"в дневнике может быть не больше {MAX_TRADES} сделок"]}
    if added:
        trades().extend(added)
        _save()
    return {"added": len(added), "skipped": skipped, "errors": errors}


def _iso(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if ms else ""


def export_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(EXPORT_COLS)
    for t in rows:
        w.writerow([_iso(t["openedAt"]), _iso(t.get("closedAt")), t["venue"], t["base"], t["quote"], t["market"],
                    t["side"], t["qty"], t["entry"], "" if t.get("exit") is None else t["exit"], t.get("fees") or 0,
                    t.get("funding") or 0, "" if t.get("pnl") is None else t["pnl"],
                    "" if t.get("leverage") is None else t["leverage"], t.get("strategy", ""),
                    ",".join(t.get("tags") or []), t.get("note", "")])
    return buf.getvalue()


# ---------- отчёт ----------

def _day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def _group(rows: list[tuple[dict, float]], key) -> list[dict]:
    acc: dict[str, list[float]] = {}
    for t, p in rows:
        acc.setdefault(key(t) or "—", []).append(p)
    out = [{"key": k, "pnl": sum(v), "count": len(v), "winRate": sum(x > 0 for x in v) / len(v) * 100}
           for k, v in acc.items()]
    return sorted(out, key=lambda r: -r["pnl"])


def select(rows: list[dict], f: dict) -> list[dict]:
    """Фильтр отчёта: период по дате закрытия (открытые — по дате входа), стратегия, биржа, рынок, монета."""
    out = []
    for t in rows:
        at = t.get("closedAt") or t["openedAt"]
        if f.get("from") and at < f["from"] or f.get("to") and at > f["to"]:
            continue
        if f.get("strategy") and t.get("strategy") != f["strategy"]:
            continue
        if f.get("venue") and t["venue"] != f["venue"]:
            continue
        if f.get("market") and t["market"] != f["market"]:
            continue
        if f.get("base") and t["base"] != f["base"]:
            continue
        out.append(t)
    return out


def report(rows: list[dict], marks: dict[str, float | None] | None = None) -> dict:
    marks = marks or {}
    closed = sorted(((t, pnl(t)) for t in rows if t.get("closedAt") is not None), key=lambda x: x[0]["closedAt"])
    closed = [(t, p) for t, p in closed if p is not None]
    vals = [p for _t, p in closed]
    wins = [p for p in vals if p > 0]
    losses = [p for p in vals if p < 0]
    equity, cum, peak, max_dd, streak, best_streak, worst_streak = [], 0.0, 0.0, 0.0, 0, 0, 0
    for t, p in closed:
        cum += p
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
        equity.append([t["closedAt"], cum])
        if p > 0:
            streak = streak + 1 if streak > 0 else 1
        elif p < 0:
            streak = streak - 1 if streak < 0 else -1
        best_streak, worst_streak = max(best_streak, streak), min(worst_streak, streak)
    holds = [(t["closedAt"] - t["openedAt"]) / 3.6e6 for t, _p in closed]
    by_day: dict[str, float] = {}
    by_month: dict[str, list[float]] = {}
    for t, p in closed:
        d = _day(t["closedAt"])
        by_day[d] = by_day.get(d, 0.0) + p
        by_month.setdefault(d[:7], []).append(p)
    open_rows = []
    for t in rows:
        if t.get("closedAt") is None:
            m = marks.get(t["id"])
            open_rows.append({**t, "mark": m, "upnl": pnl(t, m)})
    gross_win, gross_loss = sum(wins), -sum(losses)
    n = len(vals)
    return {
        "kpi": {
            "pnl": sum(vals), "trades": n, "wins": len(wins), "losses": len(losses),
            "winRate": len(wins) / n * 100 if n else 0.0,
            "avgWin": gross_win / len(wins) if wins else 0.0, "avgLoss": -gross_loss / len(losses) if losses else 0.0,
            "profitFactor": gross_win / gross_loss if gross_loss else None,  # None — убыточных сделок нет
            "expectancy": sum(vals) / n if n else 0.0,
            "best": max(vals) if vals else 0.0, "worst": min(vals) if vals else 0.0,
            "maxDrawdown": max_dd, "fees": sum(t.get("fees") or 0 for t, _p in closed),
            "funding": sum(t.get("funding") or 0 for t, _p in closed),
            "longPnl": sum(p for t, p in closed if t["side"] == "long"),
            "shortPnl": sum(p for t, p in closed if t["side"] == "short"),
            "avgHoldH": sum(holds) / len(holds) if holds else 0.0,
            "winStreak": best_streak, "lossStreak": -worst_streak,
            "openCount": len(open_rows), "upnl": sum(r["upnl"] or 0 for r in open_rows),
        },
        "equity": equity,
        "byDay": by_day,
        "byMonth": [{"key": k, "pnl": sum(v), "count": len(v)} for k, v in sorted(by_month.items())],
        "byStrategy": _group(closed, lambda t: t.get("strategy")),
        "byVenue": _group(closed, lambda t: t["venue"]),
        "byCoin": _group(closed, lambda t: t["base"]),
        "byMarket": _group(closed, lambda t: t["market"]),
        "byWeekday": _group(closed, lambda t: str(datetime.fromtimestamp(t["closedAt"] / 1000, timezone.utc).weekday())),
        "open": open_rows,
    }


def view(f: dict) -> dict:
    rows = all_trades()
    mine = select(rows, f)
    marks = {t["id"]: _mark(t) for t in mine if t.get("closedAt") is None}
    out = []
    for t in sorted(mine, key=lambda x: -(x.get("closedAt") or x["openedAt"])):
        out.append({**t, "pnlValue": pnl(t, marks.get(t["id"])), "open": t.get("closedAt") is None})
    return {
        "trades": out[:2000], "total": len(out), "report": report(mine, marks),
        "options": {
            "strategies": sorted({t.get("strategy") for t in rows if t.get("strategy")}),
            "venues": sorted({t["venue"] for t in rows if t["venue"]}),
            "coins": sorted({t["base"] for t in rows}),
        },
        "now": int(time.time() * 1000),
    }
