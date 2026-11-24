from __future__ import annotations

import time

from .market import all_quotes, funding_map, taker
from . import settings


def _leg_funding(q: dict, fund: dict) -> dict | None:
    if q["kind"] != "perp":
        return None
    return fund.get(f"{q['venue']}|perp|{q['symbol']}")


def _per_8h(leg: dict | None) -> float | None:
    if not leg or not leg.get("intervalH"):
        return None
    return leg["rate"] * (8 / leg["intervalH"])


def _funding_sum(buy: dict | None, sell: dict | None) -> float | None:
    """Шорт получает ставку продажи, лонг платит ставку покупки."""
    if not buy or not sell:
        return None
    return sell["rate"] - buy["rate"]


def _funding_8h(buy: dict | None, sell: dict | None) -> float | None:
    sell_8h = _per_8h(sell)
    buy_8h = _per_8h(buy)
    if sell_8h is None or buy_8h is None:
        return None
    return sell_8h - buy_8h


def fees_pct(buy: dict, sell: dict) -> float:
    """Комиссии taker обеих ног на вход и на выход, в процентах."""
    return (taker(buy["venue"], buy["kind"], buy["symbol"]) + taker(sell["venue"], sell["kind"], sell["symbol"])) * 2 * 100


def next_funding(buy: dict | None, sell: dict | None) -> tuple[float | None, int | None]:
    """Ближайшая выплата по связке: шорт получает ставку продажи, лонг платит ставку покупки.
    Если у ног разное время выплаты — считаем только те, что приходятся на ближайшее."""
    legs = [(leg, sign) for leg, sign in ((buy, -1), (sell, 1)) if leg and leg.get("next")]
    if not legs:
        return None, None
    at = min(leg["next"] for leg, _ in legs)
    pct = sum(sign * leg["rate"] for leg, sign in legs if leg["next"] - at < 60_000)
    return pct, at


# Время жизни спреда: спред, который висит часами, обычно значит закрытый вывод или делистинг.
LIFE_GAP_SEC = 30      # пропал дольше — считаем новым
LIFE_SAMPLE_SEC = 10
LIFE_WINDOW_SEC = 3600
_life: dict[str, dict] = {}
_life_gc = 0.0


def track_life(rows: list[dict], now: float | None = None) -> None:
    global _life_gc
    now = now or time.time()
    for r in rows:
        e = _life.get(r["id"])
        if e is None or now - e["last"] > LIFE_GAP_SEC:
            e = _life[r["id"]] = {"since": now, "last": now, "samples": []}
        e["last"] = now
        s = e["samples"]
        if not s or now - s[-1][0] >= LIFE_SAMPLE_SEC:
            s.append((now, r["spreadPct"]))
            while s and now - s[0][0] > LIFE_WINDOW_SEC:
                s.pop(0)
        r["ageSec"] = int(now - e["since"])
        r["avgPct"] = sum(p for _, p in s) / len(s)
    if now - _life_gc > 60:
        _life_gc = now
        for k in [k for k, e in _life.items() if now - e["last"] > 300]:
            _life.pop(k, None)


def group_key(q: dict) -> str:
    return f"{q['kind']}:{q['base']}/{q['quote']}"


def build_cross() -> list[dict]:
    cfg = settings.get()
    min_vol = cfg["minVolumeUsd"]
    slip = cfg["slippagePct"]
    oldest = time.time() - cfg["maxQuoteAgeSec"]
    groups: dict[str, list[dict]] = {}
    for q in all_quotes():
        if q["volumeUsd"] < min_vol:
            continue
        # Биржа перестала отвечать — её старая котировка даёт фантомный спред.
        if q.get("seen", 0) < oldest:
            continue
        groups.setdefault(group_key(q), []).append(q)

    fund = funding_map()
    rows = []
    for list_ in groups.values():
        if len(list_) < 2:
            continue
        for buy in list_:
            for sell in list_:
                if buy["venue"] == sell["venue"] or buy["ask"] <= 0 or sell["bid"] <= 0:
                    continue
                if buy["last"] <= 0 or sell["last"] <= 0:
                    continue
                ratio = max(buy["last"], sell["last"]) / min(buy["last"], sell["last"])
                if ratio > 1.25:
                    continue
                spread = (sell["bid"] - buy["ask"]) / buy["ask"] * 100
                if spread <= 0 or spread > 25:
                    continue
                buy_fund = _leg_funding(buy, fund)
                sell_fund = _leg_funding(sell, fund)
                fees = fees_pct(buy, sell)
                next_pct, next_at = next_funding(buy_fund, sell_fund)
                rows.append({
                    "id": f"{buy['kind']}:{buy['base']}/{buy['quote']}:{buy['venue']}->{sell['venue']}",
                    "base": buy["base"],
                    "quote": buy["quote"],
                    "kind": buy["kind"],
                    "buyVenue": buy["venue"],
                    "sellVenue": sell["venue"],
                    "buySymbol": buy["symbol"],
                    "sellSymbol": sell["symbol"],
                    "buyAsk": buy["ask"],
                    "sellBid": sell["bid"],
                    "spreadPct": spread,
                    "netPct": spread - fees - slip,
                    "feesPct": fees,
                    "fundNextPct": next_pct,
                    "fundNextAt": next_at,
                    "volumeUsd": min(buy["volumeUsd"], sell["volumeUsd"]),
                    "ts": min(buy["ts"], sell["ts"]),
                    "buyFundingPct": buy_fund["rate"] if buy_fund else None,
                    "sellFundingPct": sell_fund["rate"] if sell_fund else None,
                    "buyIntervalH": buy_fund.get("intervalH") if buy_fund else None,
                    "sellIntervalH": sell_fund.get("intervalH") if sell_fund else None,
                    "fundingPct": _funding_sum(buy_fund, sell_fund),
                    "funding8hPct": _funding_8h(buy_fund, sell_fund),
                })
    rows.sort(key=lambda r: -r["spreadPct"])
    track_life(rows)
    return rows


def coin_venues(base: str, quote: str, kind: str) -> list[dict]:
    """Монета на всех биржах (без фильтра объёма): цены для выбора ног спреда."""
    now = time.time()
    key = f"{kind}:{base}/{quote}"
    rows = []
    for q in all_quotes():
        if group_key(q) != key or q["bid"] <= 0 or q["ask"] <= 0:
            continue
        rows.append({
            "venue": q["venue"], "symbol": q["symbol"], "bid": q["bid"], "ask": q["ask"],
            "volumeUsd": q["volumeUsd"], "ageSec": round(now - q.get("seen", 0), 1), "ws": bool(q.get("ws")),
            "taker": taker(q["venue"], q["kind"], q["symbol"]),
        })
    rows.sort(key=lambda r: r["ask"])
    # Тот же тикер, но цена далеко от медианы — скорее другая монета или иной размер контракта (как в build_cross).
    if rows:
        mids = sorted((r["bid"] + r["ask"]) / 2 for r in rows)
        med = mids[len(mids) // 2]
        for r in rows:
            mid = (r["bid"] + r["ask"]) / 2
            r["odd"] = max(mid, med) / min(mid, med) > 1.25
    return rows


def build_funding() -> list[dict]:
    min_vol = settings.get()["minVolumeUsd"]
    qs = all_quotes()
    fund = funding_map()
    spots: dict[tuple, dict] = {}
    for s in qs:  # перебор всех котировок на каждый перп стоил секунды и блокировал сервер
        if s["kind"] == "spot":
            spots.setdefault((s["venue"], s["base"], s["quote"]), s)
    rows = []
    for q in qs:
        if q["kind"] != "perp" or q["volumeUsd"] < min_vol:
            continue
        f = fund.get(f"{q['venue']}|perp|{q['symbol']}")
        spot = spots.get((q["venue"], q["base"], q["quote"]))
        spot_px = spot["last"] if spot else 0
        basis = ((q["last"] - spot_px) / spot_px * 100) if spot_px else 0
        if not f and not spot:
            continue
        rows.append({
            "id": f"{q['venue']}:{q['symbol']}",
            "venue": q["venue"],
            "symbol": q["symbol"],
            "base": q["base"],
            "quote": q["quote"],
            "fundingPct": f["rate"] if f else 0,
            "intervalH": f.get("intervalH") if f else None,
            "mark": (f["mark"] if f and f["mark"] else q["last"]),
            "index": f.get("index") if f else None,
            "basisPct": basis,
            "volumeUsd": q["volumeUsd"],
            "ts": (f["ts"] if f else q["ts"]),
        })
    rows.sort(key=lambda r: -abs(r["fundingPct"]))
    return rows
