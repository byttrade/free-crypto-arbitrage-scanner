"""Связка одной кнопкой: обе ноги сразу, журнал и PnL.

Ноги уходят одновременно IOC-лимитками на одинаковое число монет с допуском по цене. Объём режется
по свободному балансу. Если одна нога исполнилась, а другая нет (или частично), сервер сам ничего
не досылает: в журнале появляется перекос, и пользователь решает — догнать отстающую ногу или
выровнять (закрыть лишнее на исполненной). Повтор ордера при таймауте запрещён — только сверка.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid

from bytx import errors

from . import integrity, settings, trade
from .market import quotes, taker

MIN_NOTIONAL = 5.0
_journal: list[dict] = []
_loaded = False
_busy: set[str] = set()  # связки, по которым сейчас идут ордера


def _exclusive(fn):
    """Одно действие на связку за раз: двойной клик «Закрыть» не должен отправить ордера дважды."""
    async def run(msg: dict) -> tuple[bool, str]:
        pid = str(msg.get("id") or "")
        if pid in _busy:
            return False, "по связке уже идёт действие — дождитесь ответа"
        _busy.add(pid)
        try:
            return await fn(msg)
        finally:
            _busy.discard(pid)
    return run


def _file():
    return settings.DATA_DIR / "journal.json"


def journal() -> list[dict]:
    global _loaded
    if not _loaded:
        _loaded = True
        try:
            _journal.extend(json.loads(_file().read_text(encoding="utf-8")))
        except Exception:
            pass
    return _journal


def _save() -> None:
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(_journal[-500:], indent=1), encoding="utf-8")
    tmp.replace(_file())  # атомарно: журнал денег не должен обрезаться при сбое записи


def _quote(venue: str, kind: str, symbol: str) -> dict | None:
    q = quotes.get(f"{venue}|{kind}|{symbol}")
    if not q or time.time() - q.get("seen", 0) > settings.get()["maxQuoteAgeSec"]:
        return None
    return q


async def _final(ex, symbol: str, order) -> object:
    """IOC закрывается сразу, но ответ на размещение не всегда содержит исполнение — дочитываем."""
    for _ in range(4):
        if order is not None and order.status in ("closed", "canceled", "expired", "rejected") \
                and order.filled is not None and not getattr(order, "partial_info", False):
            return order
        await asyncio.sleep(0.4)
        try:
            order = await ex.order(symbol, order.id)
        except Exception:
            pass
    return order


async def _send(session, symbol: str, side: str, size: float, price: float, reduce_only: bool = False) -> dict:
    """Одна IOC-нога. Результат — словарь для журнала, ошибки не бросает."""
    out = {"side": side, "size": size, "price": price, "filled": 0.0, "avg": None, "orderId": None, "error": None}
    try:
        order = await session.ex.ws_place_order(symbol, side, size=size, price=price, type="limit",
                                                time_in_force="IOC", reduce_only=reduce_only)
        integrity.after_order(session, order)
        order = await _final(session.ex, symbol, order)
        out.update(orderId=order.id, filled=float(order.filled or 0), avg=order.average or order.price,
                   status=order.status)
    except errors.OrderStatusUnknown as exc:
        # Ордер мог дойти: не повторяем, ищем по client_id.
        cid = getattr(exc, "client_order_id", None)
        out["error"] = f"статус неизвестен (client_id {cid})"
        if cid:
            try:
                order = await session.ex.order(symbol, client_id=cid)
                out.update(orderId=order.id, filled=float(order.filled or 0), avg=order.average or order.price,
                           status=order.status, error=None)
            except Exception:
                pass
    except Exception as exc:
        out["error"] = str(exc).split("\n")[0][:180]
    return out


def _sessions(msg: dict):
    kind = msg.get("kind") if msg.get("kind") in ("perp", "spot") else "perp"
    legs = {}
    for role in ("buy", "sell"):
        leg = msg.get(role) or {}
        s, err = trade._find(str(leg.get("venue") or ""), kind, str(leg.get("keyId") or ""))
        if s is None:
            return None, f"{role}: {err}", kind
        legs[role] = (s, str(leg.get("symbol") or ""))
    return legs, "", kind


async def _caps(legs: dict, kind: str, base: str, quote_ccy: str, buy_ask: float) -> tuple[float, str]:
    """Сколько можно поставить, в валюте котировки. Плечо не угадываем: считаем как 1x."""
    (sb, _), (ss, _) = legs["buy"], legs["sell"]
    bal_b, bal_s = await asyncio.gather(sb.ex.balance(), ss.ex.balance())
    cap_buy = bal_b.free(quote_ccy)
    if kind == "perp":
        cap_sell = bal_s.free(quote_ccy)
        why = f"свободно {cap_buy:.2f} / {cap_sell:.2f} {quote_ccy}"
    else:
        cap_sell = bal_s.free(base) * buy_ask  # спот: продаём монеты, которые уже лежат на бирже продажи
        why = f"свободно {cap_buy:.2f} {quote_ccy} / {bal_s.free(base):.6g} {base}"
    return min(cap_buy, cap_sell), why


async def _base_step(session, symbol: str) -> float:
    try:
        m = await session.ex.market(symbol)
    except Exception:
        return 0.0
    return float(m.amount_step or 0) * float(m.contract_size or 1)


async def _common_size(legs: dict, size: float) -> float:
    """Одинаковое число монет на обеих ногах: вниз до более крупного шага лота (OKX DOGE — 10 монет)."""
    steps = await asyncio.gather(*(_base_step(s, sym) for s, sym in legs.values()))
    step = max(steps)
    if step <= 0:
        return size
    return int(size / step + 1e-9) * step


def _fees(row: dict) -> float:
    """Комиссии в валюте котировки: биржевые, если пришли в ней, иначе по taker-ставке рынка."""
    total = 0.0
    for leg in row["legs"]:
        for part in [leg] + leg.get("fixes", []) + ([leg["exit"]] if leg.get("exit") else []):
            if part.get("filled") and part.get("avg"):
                total += part["filled"] * part["avg"] * taker(leg["venue"], row["kind"], leg["symbol"])
    return total


def _net_qty(leg: dict) -> tuple[float, float]:
    """Позиция ноги: (монет, средняя цена входа) с учётом догоняющих и выравнивающих ордеров."""
    qty, cost = 0.0, 0.0
    for part in [leg] + leg.get("fixes", []):
        f, px = part.get("filled") or 0.0, part.get("avg") or 0.0
        if part["side"] == leg["side"]:
            qty += f
            cost += f * px
        else:
            qty -= f
            cost -= f * px
    return qty, (cost / qty if qty > 1e-12 else 0.0)


def pnl(row: dict) -> dict:
    """PnL связки: закрытая — по ценам выхода, открытая — по текущим bid/ask (лонг выходит по bid, шорт по ask)."""
    buy = next(leg for leg in row["legs"] if leg["role"] == "buy")
    sell = next(leg for leg in row["legs"] if leg["role"] == "sell")
    qb, pb = _net_qty(buy)
    qs, ps = _net_qty(sell)
    out = {"qtyBuy": qb, "qtySell": qs, "imbalance": qb - qs, "entrySpreadPct": None, "pnl": None, "fees": _fees(row)}
    if pb and ps:
        out["entrySpreadPct"] = (ps - pb) / pb * 100
    if row.get("status") == "closed":
        xb, xs = buy.get("exit") or {}, sell.get("exit") or {}
        if xb.get("avg") and xs.get("avg"):
            out["pnl"] = (xb["avg"] - pb) * (xb.get("filled") or 0) + (ps - xs["avg"]) * (xs.get("filled") or 0) - out["fees"]
        return out
    qb_now = _quote(buy["venue"], row["kind"], buy["symbol"])
    qs_now = _quote(sell["venue"], row["kind"], sell["symbol"])
    if qb_now and qs_now and pb and ps:
        exit_fees = (qb * qb_now["bid"] * taker(buy["venue"], row["kind"], buy["symbol"])
                     + qs * qs_now["ask"] * taker(sell["venue"], row["kind"], sell["symbol"]))
        out["pnl"] = (qb_now["bid"] - pb) * qb + (ps - qs_now["ask"]) * qs - out["fees"] - exit_fees
    return out


def public_rows() -> list[dict]:
    return [{**row, **pnl(row)} for row in reversed(journal()[-200:])]


async def _push() -> None:
    from .main import broadcast

    await broadcast({"type": "journal", "rows": public_rows()})


def _status(row: dict) -> str:
    p = pnl(row)
    if p["qtyBuy"] <= 1e-12 and p["qtySell"] <= 1e-12:
        return "failed"
    tol = max(abs(p["qtyBuy"]), abs(p["qtySell"])) * 0.01  # округление размера биржами
    return "open" if abs(p["imbalance"]) <= tol else "partial"


async def open_pair(msg: dict) -> tuple[bool, str]:
    legs, err, kind = _sessions(msg)
    if legs is None:
        return False, err
    (sb, sym_b), (ss, sym_s) = legs["buy"], legs["sell"]
    if not (sb.demo and ss.demo) and msg.get("confirmLive") is not True:
        return False, "live-ключ: нужно подтверждение"
    for s in (sb, ss):
        if why := await integrity.gate(s):
            return False, f"{s.venue}: {why}"
    qb, qs = _quote(sb.venue, kind, sym_b), _quote(ss.venue, kind, sym_s)
    if not qb or not qs:
        return False, "котировки устарели — дождитесь обновления"
    tol = min(max(float(msg.get("tolPct") or 0.2), 0.02), 2.0)
    want = float(msg.get("notional") or 0)
    if want < MIN_NOTIONAL:
        return False, f"сумма меньше {MIN_NOTIONAL:g}"
    cap, why = await _caps(legs, kind, qb["base"], qb["quote"], qb["ask"])
    notional = min(want, cap * 0.98)  # запас на комиссию
    if notional < MIN_NOTIONAL:
        return False, f"мало средств ({why})"
    size = await _common_size(legs, notional / qb["ask"])
    if size <= 0:
        return False, "сумма меньше минимального лота одной из бирж"
    rb, rs = await asyncio.gather(
        _send(sb, sym_b, "buy", size, qb["ask"] * (1 + tol / 100)),
        _send(ss, sym_s, "sell", size, qs["bid"] * (1 - tol / 100)),
    )
    row = {
        "id": uuid.uuid4().hex[:12], "ts": int(time.time() * 1000), "kind": kind,
        "base": qb["base"], "quote": qb["quote"], "notional": notional, "tolPct": tol,
        "quoteSpreadPct": (qs["bid"] - qb["ask"]) / qb["ask"] * 100,
        "legs": [
            {"role": "buy", "venue": sb.venue, "symbol": sym_b, "keyId": sb.key_id, "demo": sb.demo, **rb, "fixes": []},
            {"role": "sell", "venue": ss.venue, "symbol": sym_s, "keyId": ss.key_id, "demo": ss.demo, **rs, "fixes": []},
        ],
    }
    row["status"] = _status(row)
    journal().append(row)
    _save()
    await _push()
    p = pnl(row)
    text = {"open": "связка открыта", "partial": f"перекос {p['imbalance']:+.6g} {row['base']} — догоните или выровняйте",
            "failed": "ни одна нога не исполнилась"}[row["status"]]
    errs = "; ".join(f"{leg['venue']}: {leg['error']}" for leg in row["legs"] if leg.get("error"))
    return row["status"] != "failed", text + (f" ({errs})" if errs else "") + (f" · урезано до {notional:.2f}: {why}" if notional < want else "")


def _row(pid: str) -> dict | None:
    return next((r for r in journal() if r["id"] == pid), None)


def _leg_session(leg: dict, kind: str):
    s, err = trade._find(leg["venue"], kind, leg["keyId"])
    return s, err


@_exclusive
async def fix_pair(msg: dict) -> tuple[bool, str]:
    """chase — дослать отстающую ногу до размера исполненной; unwind — закрыть лишнее на исполненной."""
    row = _row(str(msg.get("id") or ""))
    if not row or row["status"] != "partial":
        return False, "перекоса нет"
    p = pnl(row)
    gap = p["imbalance"]  # >0: купили больше, чем продали
    action = msg.get("action")
    tol = row["tolPct"]
    if action == "chase":
        leg = next(l for l in row["legs"] if l["role"] == ("sell" if gap > 0 else "buy"))
        side = leg["side"]
    elif action == "unwind":
        leg = next(l for l in row["legs"] if l["role"] == ("buy" if gap > 0 else "sell"))
        side = "sell" if leg["side"] == "buy" else "buy"
    else:
        return False, "неизвестное действие"
    s, err = _leg_session(leg, row["kind"])
    if s is None:
        return False, err
    if not s.demo and msg.get("confirmLive") is not True:
        return False, "live-ключ: нужно подтверждение"
    if action == "chase" and (why := await integrity.gate(s)):  # выровнять (уменьшить) можно всегда
        return False, why
    q = _quote(leg["venue"], row["kind"], leg["symbol"])
    if not q:
        return False, "котировка устарела"
    price = q["ask"] * (1 + tol / 100) if side == "buy" else q["bid"] * (1 - tol / 100)
    res = await _send(s, leg["symbol"], side, abs(gap), price, reduce_only=(action == "unwind" and row["kind"] == "perp"))
    leg["fixes"].append(res)
    row["status"] = _status(row)
    _save()
    await _push()
    if res.get("error"):
        return False, res["error"]
    return True, "перекос закрыт" if row["status"] == "open" else f"осталось {pnl(row)['imbalance']:+.6g}"


@_exclusive
async def close_pair(msg: dict) -> tuple[bool, str]:
    row = _row(str(msg.get("id") or ""))
    if not row or row["status"] not in ("open", "partial"):
        return False, "связка уже закрыта"
    sessions = []
    for leg in row["legs"]:
        s, err = _leg_session(leg, row["kind"])
        if s is None:
            return False, f"{leg['venue']}: {err}"
        sessions.append(s)
    if not all(s.demo for s in sessions) and msg.get("confirmLive") is not True:
        return False, "live-ключ: нужно подтверждение"
    tol = row["tolPct"]
    jobs = []
    for leg, s in zip(row["legs"], sessions):
        qty, _ = _net_qty(leg)
        q = _quote(leg["venue"], row["kind"], leg["symbol"])
        if qty <= 1e-12:
            jobs.append(asyncio.sleep(0, result={"filled": 0.0, "avg": None}))
            continue
        if not q:
            return False, f"{leg['venue']}: котировка устарела"
        side = "sell" if leg["side"] == "buy" else "buy"
        price = q["bid"] * (1 - tol / 100) if side == "sell" else q["ask"] * (1 + tol / 100)
        jobs.append(_send(s, leg["symbol"], side, qty, price, reduce_only=row["kind"] == "perp"))
    results = await asyncio.gather(*jobs)
    for leg, res in zip(row["legs"], results):
        leg["exit"] = res
    left = [abs(_net_qty(leg)[0] - (leg["exit"].get("filled") or 0)) for leg in row["legs"]]
    row["status"] = "closed" if all(x <= max(1e-9, _net_qty(l)[0] * 0.01) for x, l in zip(left, row["legs"])) else "closing"
    if row["status"] == "closed":
        row["closedAt"] = int(time.time() * 1000)
    if row["status"] == "closing":
        # Частично закрыто: досчитываем остаток в позицию как «fix», чтобы повторное закрытие взяло только его.
        for leg in row["legs"]:
            ex = leg.pop("exit")
            leg["fixes"].append({**ex, "side": ex.get("side") or ("sell" if leg["side"] == "buy" else "buy")})
        row["status"] = _status(row)
    _save()
    await _push()
    errs = "; ".join(f"{leg['venue']}: {r['error']}" for leg, r in zip(row["legs"], results) if r.get("error"))
    return row["status"] == "closed", ("связка закрыта" if row["status"] == "closed" else "закрыто не полностью") + (f" ({errs})" if errs else "")
