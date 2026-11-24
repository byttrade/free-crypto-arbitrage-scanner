"""Фильтры таблиц для каждого клиента. Сервер фильтрует все строки, а не только присланные верхние 250."""
from __future__ import annotations

from bytx.testing import EXCHANGES

KINDS = ("perp", "spot")
QUOTES = ("USDT", "USDC")
PERIODS = (1, 2, 4, 8)


def _num(v, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return min(max(x, lo), hi) if x == x else 0.0  # NaN → 0


def parse(msg: dict) -> dict:
    """Сообщение клиента → проверенный фильтр (данные из браузера — не доверяем)."""
    venues = [v for v in (msg.get("venues") or []) if v in EXCHANGES][:20]
    return {
        "q": str(msg.get("q") or "").strip().upper()[:24],
        "venues": sorted(set(venues)),
        "kind": msg.get("kind") if msg.get("kind") in KINDS else "",
        "quote": msg.get("quote") if msg.get("quote") in QUOTES else "",
        "minSpread": _num(msg.get("minSpread"), 0, 100),
        "minVol": _num(msg.get("minVol"), 0, 1e12),
        "netPos": bool(msg.get("netPos")),
        "hideBlocked": bool(msg.get("hideBlocked")),
        "maxAgeMin": _num(msg.get("maxAgeMin"), 0, 100000),
        "fundMin": _num(msg.get("fundMin"), 0, 100),
        "fundPeriod": int(msg.get("fundPeriod")) if msg.get("fundPeriod") in PERIODS else 0,
        "fundSign": msg.get("fundSign") if msg.get("fundSign") in ("+", "-") else "",
        "only": sorted({str(x).upper()[:24] for x in (msg.get("only") or [])[:200] if isinstance(x, str)}),
    }


EMPTY = parse({})


def _text_ok(row: dict, q: str, venue_keys: tuple[str, ...]) -> bool:
    return not q or q in row["base"] or any(q.lower() in str(row.get(k, "")) for k in venue_keys)


def spread_ok(row: dict, v: dict) -> bool:
    if v["only"] and row["base"] not in v["only"]:
        return False
    if not _text_ok(row, v["q"], ("buyVenue", "sellVenue")):
        return False
    if v["venues"] and not (row["buyVenue"] in v["venues"] and row["sellVenue"] in v["venues"]):
        return False
    if v["kind"] and row["kind"] != v["kind"]:
        return False
    if v["quote"] and row["quote"] != v["quote"]:
        return False
    if row["spreadPct"] < v["minSpread"] or row["volumeUsd"] < v["minVol"]:
        return False
    if v["hideBlocked"] and row.get("transfer") == "blocked":
        return False
    if v["maxAgeMin"] and row.get("ageSec", 0) > v["maxAgeMin"] * 60:
        return False
    return not v["netPos"] or row["netPct"] > 0


def funding_ok(row: dict, v: dict) -> bool:
    if v["only"] and row["base"] not in v["only"]:
        return False
    if not _text_ok(row, v["q"], ("venue",)):
        return False
    if v["venues"] and row["venue"] not in v["venues"]:
        return False
    if v["quote"] and row["quote"] != v["quote"]:
        return False
    if abs(row["fundingPct"]) < v["fundMin"] or row["volumeUsd"] < v["minVol"]:
        return False
    if v["fundPeriod"] and row.get("intervalH") != v["fundPeriod"]:
        return False
    if v["fundSign"] == "+" and row["fundingPct"] <= 0:
        return False
    return not (v["fundSign"] == "-" and row["fundingPct"] >= 0)


def spreads(rows: list[dict], v: dict, limit: int = 250) -> tuple[list[dict], int]:
    mine = rows if v == EMPTY else [r for r in rows if spread_ok(r, v)]
    return mine[:limit], len(mine)


def funding(rows: list[dict], v: dict, limit: int = 200) -> list[dict]:
    mine = rows if v == EMPTY else [r for r in rows if funding_ok(r, v)]
    return mine[:limit]
