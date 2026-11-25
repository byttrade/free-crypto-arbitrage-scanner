"""Лимитки, правка и позиции по приватному сокету bytx.

Браузер шлёт команды в тот же /ws. На биржу уходят ws_place_order / ws_amend_order /
ws_cancel_order. Открытые ордера и позиции читает приватный поток (order_tracker,
position_tracker): один REST-снимок при подключении, дальше только сокет.
"""

from __future__ import annotations

import asyncio

from bytx import create_exchange, errors

from . import integrity, vault
from .market import proxy_for

_lock = asyncio.Lock()
_sessions: dict[tuple[str, str], "Session"] = {}


class Session:
    def __init__(self, row: dict, kind: str, ex, orders, positions) -> None:
        self.key_id = row["id"]
        self.venue = row["venue"]
        self.demo = bool(row["demo"])
        self.kind = kind
        self.ex = ex
        self.orders = orders
        self.positions = positions
        self.guard = None  # integrity.Guard, created on the first order


def kick() -> None:
    asyncio.create_task(sync())


async def shutdown() -> None:
    async with _lock:
        for key in list(_sessions):
            await _stop(_sessions.pop(key))


async def sync() -> None:
    async with _lock:
        opened = vault.opened()
        wanted = {(row["id"], kind) for row in opened for kind in ("perp", "spot")}
        for key in list(_sessions):
            if key not in wanted:
                await _stop(_sessions.pop(key))
        for row in opened:
            for kind in ("perp", "spot"):
                if (row["id"], kind) not in _sessions:
                    await _start(row, kind)


async def _start(row: dict, kind: str) -> None:
    market = "spot" if kind == "spot" else "swap"
    try:
        ex = create_exchange(
            row["venue"],
            api_key=row["apiKey"],
            secret=row["secret"],
            password=row["password"] or None,
            demo=bool(row["demo"]),
            market=market,
            # Перпы OKX и Bitget без явного режима маржи ордер не принимают.
            margin_mode="cross" if kind == "perp" else None,
            proxy=proxy_for(row["venue"]),
            timeout=20,
            retries=0,
        )
        await ex.connect()
    except Exception as exc:
        print("trade connect", row["venue"], kind, type(exc).__name__, str(exc)[:160], flush=True)
        return
    orders = ex.order_tracker()
    positions = ex.position_tracker() if kind == "perp" else None
    session = Session(row, kind, ex, orders, positions)
    _sessions[(row["id"], kind)] = session
    try:
        orders.on_update(lambda _order: asyncio.create_task(push_orders(session)))
        await orders.start()
        if positions is not None:
            positions.on_update(lambda _pos: asyncio.create_task(push_positions(session)))
            await positions.start()
        await push_orders(session)
        await push_positions(session)
    except Exception as exc:
        _sessions.pop((row["id"], kind), None)
        await _stop(session)
        print("trade watch", row["venue"], kind, type(exc).__name__, str(exc)[:160], flush=True)


async def _stop(session: Session) -> None:
    for tracker in (session.positions, session.orders):
        if tracker is None:
            continue
        try:
            await tracker.stop()
        except Exception:
            pass
    try:
        await session.ex.close()
    except Exception:
        pass


def _find(venue: str, kind: str, key_id: str = "") -> tuple[Session | None, str]:
    if key_id:
        hit = _sessions.get((key_id, kind))
        if hit is None or hit.venue != venue:
            return None, "ключ ещё подключается или закрыт"
        return hit, ""
    hits = [s for s in list(_sessions.values()) if s.venue == venue and s.kind == kind]
    if not hits:
        return None, "ключ ещё подключается или закрыт"
    if len(hits) > 1:
        return None, "на бирже несколько открытых ключей — выберите ключ"
    return hits[0], ""


def _order_row(session: Session, order) -> dict:
    return {
        "id": order.id,
        "keyId": session.key_id,
        "venue": session.venue,
        "kind": session.kind,
        "demo": session.demo,
        "symbol": order.symbol,
        "side": order.side,
        "price": order.price,
        "size": order.size,
        "filled": order.filled,
        "status": order.status,
    }


def _pos_row(session: Session, pos) -> dict:
    return {
        "keyId": session.key_id,
        "venue": session.venue,
        "kind": session.kind,
        "demo": session.demo,
        "symbol": pos.symbol,
        "side": pos.side,
        "size": pos.size,
        "entry": pos.entry_price,
        "pnl": pos.unrealized_pnl,
        "leverage": pos.leverage,
        "liq": pos.liquidation_price,
    }


def _remember(session: Session, order) -> None:
    try:
        session.orders.track(order)
    except Exception:
        pass


def _orders_msg(session: Session) -> dict:
    rows = [_order_row(session, order) for order in session.orders.open_orders]
    return {"type": "orders", "keyId": session.key_id, "venue": session.venue, "kind": session.kind, "rows": rows}


def _positions_msg(session: Session) -> dict:
    rows = []
    if session.positions is not None:
        rows = [_pos_row(session, pos) for pos in session.positions.positions if pos.size]
    return {"type": "positions", "keyId": session.key_id, "venue": session.venue, "kind": session.kind, "rows": rows}


def snapshot() -> list[dict]:
    """Текущие ордера и позиции всех ключей — новой вкладке браузера (иначе она видит только изменения)."""
    out = []
    for session in list(_sessions.values()):
        try:
            out += [_orders_msg(session), _positions_msg(session)]
        except Exception:
            pass
    return out


async def push_orders(session: Session) -> None:
    from .main import broadcast

    await broadcast(_orders_msg(session))


async def push_positions(session: Session) -> None:
    from .main import broadcast

    await broadcast(_positions_msg(session))


async def _ack(socket, ok: bool, text: str) -> None:
    import json

    try:
        await socket.send_text(json.dumps({"type": "order_ack", "ok": ok, "text": text}))
    except Exception:
        pass


_closing: set[tuple] = set()  # (ключ, символ, сторона): закрытие в пути — второе не отправляем
SETTLE_SEC = 1.5  # после рыночного ордера/закрытия сверяем позицию по REST: WS позиций у бирж (Bitget demo) запаздывает


def _num(value) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


async def handle(socket, msg: dict) -> None:
    action = msg.get("type")
    kind = msg.get("kind") if msg.get("kind") in ("perp", "spot") else "perp"
    session = None
    try:
        session, err = _find(str(msg.get("venue") or ""), kind, str(msg.get("keyId") or ""))
        if session is None:
            await _ack(socket, False, err)
            return
        # Боевой ключ: всё, кроме отмены, только с подтверждением из UI.
        if not session.demo and action != "cancel" and msg.get("confirmLive") is not True:
            await _ack(socket, False, "live-ключ: нужно подтверждение")
            return
        if action in ("place", "amend"):  # отмена и закрытие позиции доступны всегда
            why = await integrity.gate(session)
            if why:
                await _ack(socket, False, why)
                return
        symbol = str(msg.get("symbol") or "")
        ex = session.ex
        if action == "place":
            side = msg.get("side")
            market = msg.get("orderType") == "market"
            price = _num(msg.get("price")) or 0
            notional = _num(msg.get("notional")) or 0
            if side not in ("buy", "sell") or notional <= 0 or (price <= 0 and not market):
                await _ack(socket, False, "нужны сторона, цена и сумма")
                return
            if market:
                order = await ex.ws_place_order(symbol, side, notional=notional, type="market")
            else:
                order = await ex.ws_place_order(symbol, side, notional=notional, price=price, type="limit",
                                                post_only=msg.get("postOnly") is True)
            integrity.after_order(session, order)
            _remember(session, order)
            mark = "demo" if session.demo else "live"
            at = "market" if market else order.price
            await _ack(socket, True, f"{mark}: {order.side} {order.symbol} @ {at}")
            if market:
                asyncio.create_task(_settle(session))
        elif action == "amend":
            order = await ex.ws_amend_order(
                symbol,
                str(msg.get("orderId") or ""),
                price=_num(msg.get("price")),
                size=_num(msg.get("size")),
                side=msg.get("side") if msg.get("side") in ("buy", "sell") else None,
            )
            _remember(session, order)
            await _ack(socket, True, "лимитка изменена")
        elif action == "cancel":
            order = await ex.ws_cancel_order(symbol, str(msg.get("orderId") or ""))
            _remember(session, order)
            await _ack(socket, True, "лимитка снята")
        elif action == "close":
            if session.positions is None:
                await _ack(socket, False, "позиции только на перпах")
                return
            pos = session.positions.get(symbol, msg.get("side") or None)
            if pos is None or not pos.size:
                await _ack(socket, False, "позиции нет")
                return
            part = _num(msg.get("fraction")) or 1.0
            price = _num(msg.get("price"))
            if not 0 < part <= 1 or (msg.get("orderType") == "limit" and not price):
                await _ack(socket, False, "доля закрытия от 0 до 100%, для лимитки нужна цена")
                return
            busy = (session.key_id, symbol, pos.side)
            if busy in _closing:
                await _ack(socket, False, "закрытие уже отправлено — дождитесь ответа")
                return
            _closing.add(busy)
            try:
                side = "sell" if pos.side == "long" else "buy"
                how = {"price": price, "type": "limit"} if msg.get("orderType") == "limit" else {"type": "market"}
                # Шаг лота биржа округлит вниз; 100% — ровно вся позиция, без округления доли.
                amount = {"contracts": pos.contracts * part} if pos.contracts else {"size": pos.size * part}
                order = await ex.ws_place_order(symbol, side, reduce_only=True, **amount, **how)
            finally:
                _closing.discard(busy)
            _remember(session, order)
            pct = f"{part * 100:g}%"
            await _ack(socket, True, f"закрытие {pct} отправлено" + (f" лимиткой @ {order.price}" if how["type"] == "limit" else ""))
            asyncio.create_task(_settle(session))
        else:
            return
        await push_orders(session)
        await push_positions(session)
    except errors.PositionAlreadyClosed:
        await _ack(socket, False, "позиции на бирже уже нет")
        if session is not None:
            asyncio.create_task(_reconcile(session))
    except errors.OrderTooSmall:
        await _ack(socket, False, "меньше минимального лота биржи — закройте большую долю")
    except errors.OrderStatusUnknown as exc:
        # Ордер мог дойти: не повторяем, сверяем по client_id через трекер.
        cid = getattr(exc, "client_order_id", None) or "—"
        await _ack(socket, False, f"статус ордера неизвестен (client_id {cid}), сверяю с биржей — не повторяйте")
        if session is not None:
            asyncio.create_task(_reconcile(session))
    except Exception as exc:
        await _ack(socket, False, str(exc).split("\n")[0][:180])


async def _settle(session: Session) -> None:
    await asyncio.sleep(SETTLE_SEC)
    await _reconcile(session)


async def _reconcile(session: Session) -> None:
    try:
        await session.orders.resync()
        if session.positions is not None:
            await session.positions.resync()
    except Exception:
        pass
    await push_orders(session)
    await push_positions(session)
