from __future__ import annotations

import asyncio
import json

from . import settings
from .market import load_candles, load_ohlc, liquid_bases
from .mathutil import adf_p, align, coint_age_bars, half_life, mean_revert, ols, pearson, returns, z_scores

_pairs: list[dict] = []
_running = False
_last = 0
_status = "idle"
_cache: dict[str, list[tuple[int, float]]] = {}
_hist: dict[str, dict[str, list[tuple[int, float]]]] = {}
_PAGE = 200
_TF_MS = 4 * 60 * 60 * 1000


def rows() -> list[dict]:
    return _pairs


def info() -> dict:
    return {"running": _running, "lastRun": _last, "status": _status, "count": len(_pairs)}


async def _candles(venue: str, symbol: str) -> list[tuple[int, float]]:
    key = f"{venue}|{symbol}"
    hit = _cache.get(key)
    if hit and len(hit) > 50:
        return hit
    data = await load_candles(venue, symbol, "perp", "4h", 500)
    if len(data) > 50:
        _cache[key] = data
    return data


def _compute(series: dict, cfg: dict) -> list[dict]:
    """Тяжёлый расчёт всех пар — в отдельном потоке, иначе сервер стоит секунды (замер: 5,9 с)."""
    keys = list(series)
    nxt = []
    for i, ka in enumerate(keys):
        for kb in keys[i + 1:]:
            a, b = series[ka], series[kb]
            xs, ys, ts = align(b["c"], a["c"])
            if len(ts) < 80:
                continue
            corr = pearson(returns(ys), returns(xs))
            if abs(corr) < cfg["corrMin"]:
                continue
            intercept, hedge = ols(xs, ys)
            spread = [ys[k] - (intercept + hedge * xs[k]) for k in range(len(ys))]
            p = adf_p(spread)
            if p > 0.12:
                continue
            z = z_scores(spread)
            hl = half_life(spread)
            bt = mean_revert(z, ts, cfg["zEntry"], cfg["zExit"], 4)
            age = coint_age_bars(spread)
            nxt.append({
                "id": f"{a['q']['base']}-{b['q']['base']}",
                "y": a["q"]["base"],
                "x": b["q"]["base"],
                "yVenue": a["q"]["venue"],
                "xVenue": b["q"]["venue"],
                "ySymbol": a["q"]["symbol"],
                "xSymbol": b["q"]["symbol"],
                "corr": corr,
                "cointP": p,
                "hedge": hedge,
                "halfLifeBars": hl,
                "halfLifeHours": None if hl >= 999 else round(hl * 4, 1),
                "cointAgeBars": age,
                "sampleFrom": ts[0],
                "sampleTo": ts[-1],
                "z": z[-1] if z else 0,
                "spreadNow": spread[-1] if spread else 0,
                "winRate": bt["winRate"],
                "trades": bt["trades"],
                "avgHours": bt["avgHours"],
                "lastSignal": bt["last"],
            })
    return nxt


async def run() -> None:
    global _running, _pairs, _last, _status
    if _running:
        return
    _running = True
    cfg = settings.get()
    _status = "грузим свечи"
    try:
        bases = liquid_bases(cfg["minVolumeUsd"])[:160]
        if len(bases) < 8:
            _status = "мало ликвидных перпов"
            return
        series = {}
        sem = asyncio.Semaphore(6)

        async def one(q):
            async with sem:
                c = await _candles(q["venue"], q["symbol"])
                if len(c) >= 80:
                    series[q["base"]] = {"q": q, "c": c}

        await asyncio.gather(*(one(q) for q in bases))
        _status = f"считаем {len(series)} монет"
        nxt = await asyncio.to_thread(_compute, series, cfg)
        nxt.sort(key=lambda r: (-abs(r["z"]), r["cointP"]))
        _pairs = nxt[:400]
        _last = int(__import__("time").time() * 1000)
        _status = "готово"
        path = settings.DATA_DIR / "research.json"
        path.write_text(json.dumps({"lastRun": _last, "count": len(_pairs)}), encoding="utf-8")
    except Exception as e:
        _status = str(e)[:200]
    finally:
        _running = False


def _merge(rows: list[tuple[int, float]]) -> list[tuple[int, float]]:
    return sorted({t: c for t, c in rows}.items())


async def _older(venue: str, symbol: str, until: int) -> list[tuple[int, float]]:
    since = until - _PAGE * _TF_MS
    rows = await load_ohlc(venue, symbol, "perp", "4h", _PAGE, since, until)
    return [(int(row["t"]), float(row["c"])) for row in rows if row["t"] < until]


async def history(pid: str, until: int | None = None) -> dict | None:
    row = next((p for p in _pairs if p["id"] == pid), None)
    if not row:
        return None
    slot = _hist.get(pid)
    if until and slot:
        y_old = await _older(row["yVenue"], row["ySymbol"], until)
        x_old = await _older(row["xVenue"], row["xSymbol"], until)
        yc = _merge(y_old + slot["yc"])
        xc = _merge(x_old + slot["xc"])
    else:
        yc = list(await _candles(row["yVenue"], row["ySymbol"]))
        xc = list(await _candles(row["xVenue"], row["xSymbol"]))
    _hist.pop(pid, None)  # в конец очереди: вытесняем давно не открытые
    _hist[pid] = {"yc": yc, "xc": xc}
    while len(_hist) > 40:  # история листается вглубь — держим только последние открытые пары
        _hist.pop(next(iter(_hist)))
    xs, ys, ts = align(xc, yc)
    a, b = ols(xs, ys)
    spread = [ys[i] - (a + b * xs[i]) for i in range(len(ys))]
    z = z_scores(spread)
    cfg = settings.get()
    bt = mean_revert(z, ts, cfg["zEntry"], cfg["zExit"], 4)
    return {
        "row": row,
        "a": a,
        "b": b,
        "points": [{"ts": ts[i], "y": ys[i], "x": xs[i], "spread": spread[i], "z": z[i]} for i in range(len(ts))],
        "backtest": bt,
    }
