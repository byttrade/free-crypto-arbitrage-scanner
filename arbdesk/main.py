from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import alerts, research, settings, trade, vault
from . import views as view
from . import arb_exec, depth, diary, integrity, transfers, update
from . import __version__
from . import auth
from .guard import Gate, local_host
from .market import (
    adapter_status,
    book_feed,
    close_clients,
    open_clients,
    load_ohlc,
    poll_funding,
    start_pollers,
    sync_live,
    live_info,
    sync_watch,
)
from .spreads import build_cross, build_funding, coin_venues
from .telegram import poll_bot, send as tg_send

WEB = Path(__file__).resolve().parent / "web"  # собранный интерфейс (npm run build:web)

clients: set[WebSocket] = set()
wanted_books: dict[WebSocket, list[dict]] = {}
views: dict[WebSocket, dict] = {}
_coin_legs: dict[tuple[str, str, str], float] = {}
_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _updater
    settings.load()
    vault.load()
    if vault.restore(update.take_handoff()):  # перезапуск после обновления: ключи остались открытыми
        trade.kick()
    _updater = update.Updater(settings.DATA_DIR, mode=settings.get()["autoUpdate"])
    asyncio.create_task(asyncio.to_thread(integrity.clean))  # заранее, чтобы первый ордер не ждал
    open_clients()
    start_pollers()
    _tasks.extend(asyncio.create_task(_supervise(fn)) for fn in (
        _tick_loop, _funding_loop, _research_loop, _tg_loop, _book_loop, _feed_loop, _transfer_loop, _update_loop,
    ))
    yield
    for t in _tasks:
        t.cancel()
    await trade.shutdown()
    await close_clients()


app = FastAPI(title="BYTtrade Arb Terminal", lifespan=lifespan)
# CORS не нужен: UI отдаётся с того же адреса. Чужие Origin и Host — 403.
app.add_middleware(Gate)


async def broadcast(obj: dict) -> None:
    raw = json.dumps(obj, default=float)
    await _send_each(lambda _ws: raw)


async def _send_each(make) -> None:
    """make(ws) -> текст для этого клиента (у каждого свой поиск)."""
    dead = []
    for ws in list(clients):
        try:
            raw = make(ws)
            # Медленный или зависший клиент не должен останавливать котировки для всех.
            await asyncio.wait_for(ws.send_text(raw), 3)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)
        wanted_books.pop(ws, None)
        views.pop(ws, None)


async def send_spreads(rows: list[dict]) -> None:
    cache: dict[str, str] = {}

    def make(ws):
        v = views.get(ws, view.EMPTY)
        key = json.dumps(v, sort_keys=True)
        if key not in cache:
            mine, total = view.spreads(rows, v)
            cache[key] = json.dumps({"type": "spreads", "rows": mine, "total": total}, default=float)
        return cache[key]

    await _send_each(make)


async def send_funding(rows: list[dict]) -> None:
    cache: dict[str, str] = {}

    def make(ws):
        v = views.get(ws, view.EMPTY)
        key = json.dumps(v, sort_keys=True)
        if key not in cache:
            cache[key] = json.dumps({"type": "funding", "rows": view.funding(rows, v)}, default=float)
        return cache[key]

    await _send_each(make)


@app.get("/api/health")
async def health():
    return {"ok": True, "product": "BYTtrade Arb Terminal", "quotes": adapter_status(), "research": research.info(),
            "loops": {k: v for k, v in _loops.items()}, "live": live_info(),
            "transfers": transfers.info()}


_updater: update.Updater | None = None
_update_wake = asyncio.Event()


async def _update_loop():
    """Раз в 10 минут (или по кнопке): проверка и установка обновлений в тихом окне, затем перезапуск."""
    while True:
        try:
            await asyncio.wait_for(_update_wake.wait(), 600)
        except asyncio.TimeoutError:
            pass
        _update_wake.clear()
        _updater.mode = settings.get()["autoUpdate"] if update.can_restart() else "notify"
        if await asyncio.to_thread(_updater.run) == "restart":
            for _ in range(update.DRAIN_SEC):  # ордера в полёте дописываются до конца
                if not update.busy:
                    break
                await asyncio.sleep(1)
            update.request_restart()
            return


@app.get("/api/update")
async def get_update():
    st = _updater.status() if _updater else {}
    return {**st, "mode": settings.get()["autoUpdate"], "version": __version__, "canRestart": update.can_restart(), "updating": update.updating,
            "blocked": integrity.blocked, "wait": update.safe_window()}


@app.post("/api/update")
async def post_update(req: Request):
    body = await req.json()
    if body.get("mode") in ("on", "notify", "off"):
        settings.save({"autoUpdate": body["mode"]})
    if body.get("now"):
        _updater.force = True
        _update_wake.set()
    return await get_update()


def _secure(req: Request) -> bool:
    return req.url.scheme == "https" or req.headers.get("x-forwarded-proto") == "https"


def _with_cookie(req: Request, body: dict) -> JSONResponse:
    resp = JSONResponse(body)
    resp.set_cookie(auth.COOKIE, auth.make_cookie(), max_age=auth.TTL, httponly=True, samesite="strict",
                    secure=_secure(req), path="/")
    return resp


@app.get("/api/auth/status")
async def auth_status(req: Request):
    acc = auth.account()
    user = auth.session_user(req.cookies.get(auth.COOKIE))
    local = not auth.public and local_host(req.headers.get("host", ""))
    return {"account": bool(acc), "user": user, "authed": bool(user) or (not acc and local),
            "public": auth.public, "setup": not acc and (local or auth.public), "needToken": auth.public and not acc}


@app.post("/api/auth/setup")
async def auth_setup(req: Request):
    body = await req.json()
    if not auth.setup_allowed(body.get("token"), local_host(req.headers.get("host", ""))):
        raise HTTPException(403, "учётная запись уже есть или ссылка устарела — возьмите новую в терминале сервера")
    if body.get("password") != body.get("password2"):
        raise HTTPException(400, "пароли не совпадают")
    try:
        auth.save_account(str(body.get("user") or "").strip(), str(body.get("password") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _with_cookie(req, {"ok": True})


@app.post("/api/auth/login")
async def auth_login(req: Request):
    ip = req.client.host if req.client else "?"
    if wait := auth.throttled(ip):
        raise HTTPException(429, f"слишком много попыток, подождите {wait} с")
    body = await req.json()
    if not auth.check_password(str(body.get("user") or "").strip(), str(body.get("password") or "")):
        auth.failed(ip)
        raise HTTPException(401, "неверный логин или пароль")
    auth.succeeded(ip)
    return _with_cookie(req, {"ok": True})


@app.post("/api/auth/logout")
async def auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/settings")
async def get_settings():
    return settings.public()


@app.post("/api/settings")
async def post_settings(req: Request):
    settings.save(await req.json())
    return settings.public()


@app.get("/api/keys")
async def get_keys():
    return {"rows": vault.public()}


@app.post("/api/keys")
async def post_key(req: Request):
    body = await req.json()
    try:
        row = vault.add(
            str(body.get("venue") or ""),
            str(body.get("apiKey") or ""),
            str(body.get("apiSecret") or ""),
            str(body.get("password") or ""),
            str(body.get("vaultSecret") or ""),
            bool(body.get("demo", True)),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        rows = await vault.refresh()
    except Exception:
        rows = vault.public()
    trade.kick()
    return {"row": row, "rows": rows}


@app.post("/api/keys/unlock")
async def unlock_keys(req: Request):
    body = await req.json()
    try:
        vault.unlock(str(body.get("vaultSecret") or ""))
    except Exception as exc:
        raise HTTPException(400, "секрет не подошёл") from exc
    rows = await vault.refresh()
    trade.kick()
    return {"rows": rows}


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str):
    vault.remove(key_id)
    trade.kick()
    return {"rows": vault.public()}


@app.post("/api/telegram/test")
async def telegram_test():
    err = await tg_send("BYTtrade Arb Terminal: тест уведомления")
    return {"ok": not err, "error": err}


@app.get("/api/candles")
async def candles(
    venue: str,
    symbol: str,
    kind: str = "perp",
    tf: str = "5m",
    limit: int = 160,
    since: int = 0,
    until: int = 0,
):
    if kind not in ("perp", "spot") or tf not in ("1m", "5m", "15m", "1h", "4h", "1d"):
        raise HTTPException(400, "bad candles request")
    rows = await load_ohlc(
        venue, symbol, kind, tf, max(30, min(limit, 1000)), since or None, until or None,
    )
    return {"candles": rows}


@app.get("/api/spreads")
async def spreads(search: str = "", kind: str = "", limit: int = 250):
    rows = build_cross()
    if kind:
        rows = [r for r in rows if r["kind"] == kind]
    if search:
        s = search.upper()
        rows = [r for r in rows if s in r["base"] or s in r["quote"]]
    return {"rows": rows[: min(limit, 1000)], "total": len(rows)}


@app.get("/api/coin")
async def coin(base: str, quote: str = "USDT", kind: str = "perp"):
    if kind not in ("perp", "spot"):
        raise HTTPException(400, "bad kind")
    rows = coin_venues(base.upper(), quote.upper(), kind)
    now = __import__("time").time()
    for r in rows:  # открытая монета — её цены на всех биржах тоже по WS
        _coin_legs[(r["venue"], kind, r["symbol"])] = now
    return {"rows": rows, "maxAgeSec": settings.get()["maxQuoteAgeSec"]}


@app.get("/api/funding")
async def funding():
    return {"rows": build_funding()[:300]}


@app.get("/api/pairs")
async def pairs():
    return {"rows": research.rows(), "research": research.info()}


@app.get("/api/pairs/{pid}")
async def pair_one(pid: str, until: int = 0):
    return await research.history(pid, until or None)


@app.get("/api/journal")
async def get_journal():
    return {"rows": arb_exec.public_rows()}


UPDATING = "идёт обновление панели, ордера на минуту приостановлены — повторите после перезапуска"


async def _trade(socket: WebSocket, msg: dict) -> None:
    if update.updating:
        await socket.send_text(json.dumps({"type": "order_ack", "ok": False, "text": UPDATING}))
        return
    async with update.activity():
        await trade.handle(socket, msg)


async def _pair(socket: WebSocket, msg: dict) -> None:
    fn = {"pair_open": arb_exec.open_pair, "pair_fix": arb_exec.fix_pair, "pair_close": arb_exec.close_pair,
          "pair_dismiss": arb_exec.dismiss_pair}[msg["type"]]
    try:
        if update.updating:
            ok, text = False, UPDATING
        else:
            async with update.activity():
                ok, text = await fn(msg)
    except Exception as exc:  # деньги: любую ошибку показываем, а не теряем в логе
        ok, text = False, str(exc).split("\n")[0][:180]
    try:
        await socket.send_text(json.dumps({"type": "order_ack", "ok": ok, "text": text}))
    except Exception:
        pass


def _diary_filter(req: Request) -> dict:
    q = req.query_params
    f = {k: q.get(k, "")[:32] for k in ("strategy", "venue", "market", "base")}
    for k in ("from", "to"):
        try:
            f[k] = int(q.get(k) or 0) or None
        except ValueError:
            f[k] = None
    return f


@app.get("/api/diary")
async def get_diary(req: Request):
    return diary.view(_diary_filter(req))


@app.post("/api/diary")
async def save_trade(req: Request):
    try:
        return {"trade": diary.upsert(await req.json())}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/diary/{tid}")
async def delete_trade(tid: str):
    return {"ok": diary.delete(tid)}


@app.post("/api/diary/import")
async def import_trades(req: Request):
    body = await req.body()
    if len(body) > 5_000_000:
        raise HTTPException(413, "файл больше 5 МБ")
    return diary.import_csv(body.decode("utf-8", errors="replace"))


@app.get("/api/diary/export.csv")
async def export_trades(req: Request):
    rows = diary.select(diary.all_trades(), _diary_filter(req))
    rows.sort(key=lambda t: t["openedAt"])
    return Response(diary.export_csv(rows), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="arbdesk-trades.csv"'})


@app.get("/api/alerts")
async def get_alerts():
    return {"rows": alerts.log()}


@app.get("/api/status")
async def get_status():
    return {"adapters": adapter_status(), "research": research.info()}


@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    clients.add(socket)
    wanted_books[socket] = []
    await socket.send_text(json.dumps({"type": "hello", "settings": settings.public(), "alerts": alerts.log()}, default=float))
    await socket.send_text(json.dumps({"type": "spreads", "rows": build_cross()[:250]}, default=float))
    await socket.send_text(json.dumps({"type": "pairs", "rows": research.rows(), "research": research.info()}, default=float))
    await socket.send_text(json.dumps({"type": "funding", "rows": build_funding()[:200]}, default=float))
    await socket.send_text(json.dumps({"type": "journal", "rows": arb_exec.public_rows()}, default=float))
    off = alerts.on_alert(lambda a: asyncio.create_task(socket.send_text(json.dumps({"type": "alert", "alert": a}, default=float))))
    try:
        while True:
            raw = await socket.receive_text()
            msg = json.loads(raw)
            if msg.get("type") == "books":
                wanted_books[socket] = (msg.get("books") or [])[:4]
            elif msg.get("type") == "view":
                v = views[socket] = view.parse(msg)
                mine, total = view.spreads(build_cross(), v)
                await socket.send_text(json.dumps({"type": "spreads", "rows": mine, "total": total}, default=float))
                await socket.send_text(json.dumps({"type": "funding", "rows": view.funding(build_funding(), v)}, default=float))
            elif msg.get("type") in ("place", "amend", "cancel", "close"):
                asyncio.create_task(_trade(socket, msg))
            elif msg.get("type") in ("pair_open", "pair_fix", "pair_close", "pair_dismiss"):
                asyncio.create_task(_pair(socket, msg))
    except WebSocketDisconnect:
        pass
    finally:
        off()
        clients.discard(socket)
        wanted_books.pop(socket, None)
        views.pop(socket, None)


if WEB.exists():
    assets = WEB / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(WEB / "index.html")

    @app.get("/{path:path}")
    async def spa(path: str):
        if path.startswith("api") or path == "ws":
            return JSONResponse({"error": "not found"}, status_code=404)
        file = WEB / path
        if file.is_file():
            return FileResponse(file)
        return FileResponse(WEB / "index.html")


_loops: dict[str, dict] = {}


async def _supervise(fn) -> None:
    """Цикл не должен умирать молча: CancelledError из ccxt/aiohttp — не повод остановить котировки."""
    name = fn.__name__.strip("_")
    while True:
        try:
            await fn()
        except asyncio.CancelledError as e:
            if asyncio.current_task().cancelling():
                raise
            _loops.setdefault(name, {})["restarts"] = _loops.get(name, {}).get("restarts", 0) + 1
            _loops[name]["lastError"] = f"CancelledError {e}"[:200]
            print("loop", name, "cancelled from inside, restart")
        except Exception as e:
            _loops.setdefault(name, {})["restarts"] = _loops.get(name, {}).get("restarts", 0) + 1
            _loops[name]["lastError"] = repr(e)[:200]
            print("loop", name, repr(e))
        await asyncio.sleep(1)


def _beat(name: str) -> None:
    _loops.setdefault(name, {})["beat"] = int(__import__("time").time())


async def _tick_loop():
    n = 0
    while True:
        try:
            rows = build_cross()
            if n % 5 == 0:  # раз в ~2 с: стаканы верхних строк для спреда на объём
                depth.refresh(rows)
            depth.annotate(rows)
            transfers.annotate(rows)
            if n % 25 == 0:  # раз в ~10 с: WS-цены для верхних строк и открытых стаканов
                legs = [(b["venue"], b.get("kind") or "perp", b["symbol"])
                        for books in wanted_books.values() for b in books if b.get("venue") and b.get("symbol")]
                fresh = __import__("time").time() - 15
                for leg, at in list(_coin_legs.items()):
                    if at < fresh:
                        _coin_legs.pop(leg)
                legs += list(_coin_legs)
                for r in rows[:60]:
                    legs += [(r["buyVenue"], r["kind"], r["buySymbol"]), (r["sellVenue"], r["kind"], r["sellSymbol"])]
                sync_live(list(dict.fromkeys(legs)))
            n += 1
            alerts.check_spreads(rows)
            await send_spreads(rows)
            _beat("tick_loop")
        except Exception as e:
            print("tickers", e)
        await asyncio.sleep(0.4)


async def _funding_loop():
    while True:
        try:
            await poll_funding()
            rows = build_funding()
            alerts.check_funding(rows)
            await send_funding(rows)
        except Exception as e:
            print("funding", e)
        await asyncio.sleep(30)


async def _transfer_loop():
    await asyncio.sleep(20)  # сначала котировки
    while True:
        await transfers.poll()
        await asyncio.sleep(60)


async def _research_loop():
    await asyncio.sleep(12)
    while True:
        try:
            await research.run()
            await broadcast({"type": "pairs", "rows": research.rows(), "research": research.info()})
        except Exception as e:
            print("research", e)
        await asyncio.sleep(30 * 60)


async def _tg_loop():
    while True:
        try:
            await poll_bot()
        except Exception:
            pass
        await asyncio.sleep(2.5)


async def _book_loop():
    while True:
        seen: dict[str, dict] = {}
        for books in wanted_books.values():
            for b in books:
                seen[f"{b.get('venue')}|{b.get('kind')}|{b.get('symbol')}"] = b
        sync_watch(list(seen.values()))
        await asyncio.sleep(0.4)


async def _feed_loop():
    while True:
        msg = await book_feed().get()
        await broadcast(msg)
