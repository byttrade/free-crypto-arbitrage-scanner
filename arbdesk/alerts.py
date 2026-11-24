from __future__ import annotations

import time

from . import settings
from .market import VENUE_LABEL
from .telegram import can_send, send, take_dropped, take_slot

_hist: dict[str, list[tuple[float, float]]] = {}
_log: list[dict] = []
_listeners: list = []


def log() -> list[dict]:
    return _log[-80:]


def on_alert(fn):
    _listeners.append(fn)
    return lambda: _listeners.remove(fn) if fn in _listeners else None


def _emit(a: dict) -> None:
    _log.append(a)
    if len(_log) > 200:
        del _log[0]
    for fn in list(_listeners):
        fn(a)
    import asyncio
    if not take_slot(settings.get()["tgMaxPerMin"]):
        return  # в панели алерт есть, в Telegram — сверх лимита не шлём
    skipped = take_dropped()
    tail = f"\n(пропущено из-за лимита: {skipped})" if skipped else ""
    asyncio.create_task(send(f"{a['title']}\n{a['text']}{tail}\n\nне финсовет · byttrade"))


def _fmt(n: float) -> str:
    if n >= 1e9:
        return f"{n/1e9:.1f}B"
    if n >= 1e6:
        return f"{n/1e6:.1f}M"
    if n >= 1e3:
        return f"{n/1e3:.0f}K"
    return f"{n:.0f}"


def check_spreads(rows: list[dict]) -> None:
    cfg = settings.get()
    now = time.time()
    window = cfg["velocityWindowSec"]
    watch = set(cfg.get("watch") or [])
    for row in rows:
        if row["base"] in watch and row["netPct"] >= cfg["watchNetPct"] and can_send(f"w:{row['id']}", cfg["cooldownSec"]):
            _emit({
                "id": f"w:{row['id']}:{int(now*1000)}",
                "kind": "watch",
                "title": f"★ {row['base']}/{row['quote']} {row['kind']} нетто {row['netPct']:.2f}%",
                "text": (
                    f"купить {VENUE_LABEL.get(row['buyVenue'], row['buyVenue'])} ask {row['buyAsk']}\n"
                    f"продать {VENUE_LABEL.get(row['sellVenue'], row['sellVenue'])} bid {row['sellBid']}\n"
                    f"спред {row['spreadPct']:.2f}% · объём ${_fmt(row['volumeUsd'])}"
                ),
                "ts": int(now * 1000),
            })
    for row in rows[:400]:
        key = row["id"]
        arr = _hist.get(key, [])
        arr.append((now, row["spreadPct"]))
        arr = [p for p in arr if now - p[0] <= max(window, 60)]
        _hist[key] = arr
        if row["volumeUsd"] < cfg["minVolumeUsd"]:
            continue
        if row["spreadPct"] >= cfg["minSpreadPct"] and can_send(f"th:{key}", cfg["cooldownSec"]):
            _emit({
                "id": f"th:{key}:{int(now*1000)}",
                "kind": "threshold",
                "title": f"Спред {row['base']}/{row['quote']} {row['spreadPct']:.2f}%",
                "text": (
                    f"купить {VENUE_LABEL.get(row['buyVenue'], row['buyVenue'])} ask {row['buyAsk']}\n"
                    f"продать {VENUE_LABEL.get(row['sellVenue'], row['sellVenue'])} bid {row['sellBid']}\n"
                    f"нетто {row['netPct']:.2f}% · объём ${_fmt(row['volumeUsd'])}"
                ),
                "ts": int(now * 1000),
            })
        old = next((p for p in arr if now - p[0] >= window * 0.7), None)
        if old and row["spreadPct"] - old[1] >= cfg["velocityPct"] and can_send(f"vel:{key}", cfg["cooldownSec"]):
            _emit({
                "id": f"vel:{key}:{int(now*1000)}",
                "kind": "velocity",
                "title": f"Расширение {row['base']}/{row['quote']} +{row['spreadPct']-old[1]:.2f}%",
                "text": (
                    f"{old[1]:.2f}% → {row['spreadPct']:.2f}% за {int(window)}с\n"
                    f"{VENUE_LABEL.get(row['buyVenue'], row['buyVenue'])} → {VENUE_LABEL.get(row['sellVenue'], row['sellVenue'])}"
                ),
                "ts": int(now * 1000),
            })


def check_funding(rows: list[dict]) -> None:
    cfg = settings.get()
    now = time.time()
    for row in rows[:80]:
        if abs(row["fundingPct"]) < cfg["minFundingPct"]:
            continue
        key = f"f:{row['id']}"
        if not can_send(key, cfg["cooldownSec"]):
            continue
        _emit({
            "id": f"{key}:{int(now*1000)}",
            "kind": "funding",
            "title": f"Фандинг {row['base']} {row['fundingPct']:.3f}%",
            "text": f"{VENUE_LABEL.get(row['venue'], row['venue'])} {row['symbol']}\nbasis {row['basisPct']:.3f}%",
            "ts": int(now * 1000),
        })
