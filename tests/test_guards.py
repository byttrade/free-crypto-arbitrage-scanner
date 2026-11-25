"""Проверки защит терминала. Без сети: lifespan не запускается, биржи не трогаем.

pip install -r requirements.txt pytest httpx && python -m pytest tests -q
"""
import asyncio
import json
import time

import pytest
from bytx import errors
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    from arbdesk import settings
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(settings, "FILE", tmp_path / "settings.json")
    monkeypatch.setattr(settings, "_current", dict(settings.DEFAULTS))


def test_allowed_hosts_and_origins(monkeypatch):
    from arbdesk.guard import allowed
    monkeypatch.delenv("ALLOWED_HOSTS", raising=False)
    assert allowed("127.0.0.1:8780", None)
    assert allowed("localhost:8780", "http://localhost:5173")
    assert allowed("[::1]:8780", "http://[::1]:8780")
    assert not allowed("127.0.0.1:8780", "https://evil.example")
    assert not allowed("evil.example:8780", None)  # DNS rebinding
    monkeypatch.setenv("ALLOWED_HOSTS", "box.lan")
    assert allowed("box.lan:8780", "http://box.lan:8780")


def _app():
    from arbdesk.guard import Gate
    app = FastAPI()
    app.add_middleware(Gate)

    @app.post("/api/x")
    async def x():
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        await sock.send_text("hi")
        await sock.close()

    return app


def test_middleware_blocks_foreign_origin_http_and_ws():
    c = TestClient(_app(), base_url="http://127.0.0.1:8780")
    assert c.post("/api/x").status_code == 200
    assert c.post("/api/x", headers={"Origin": "https://evil.example"}).status_code == 403
    with c.websocket_connect("ws://127.0.0.1:8780/ws", headers={"Origin": "http://127.0.0.1:8780"}) as s:
        assert s.receive_text() == "hi"
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("ws://127.0.0.1:8780/ws", headers={"Origin": "https://evil.example"}) as s:
            s.receive_text()


def test_token_masked_and_mask_not_saved():
    from arbdesk import settings
    settings.save({"telegramToken": "123:SECRETabcd"})
    pub = settings.public()
    assert "SECRET" not in json.dumps(pub) and pub["telegramToken"].endswith("abcd")
    settings.save({"telegramToken": pub["telegramToken"], "minSpreadPct": 1})
    assert settings.get()["telegramToken"] == "123:SECRETabcd"


def test_telegram_global_limit():
    from arbdesk import telegram
    telegram._window.clear()
    now = 1000.0
    sent = sum(telegram.take_slot(5, now + i * 0.1) for i in range(50))
    assert sent == 5 and telegram.take_dropped() == 45
    assert telegram.take_slot(5, now + 61)  # окно сдвинулось


def test_stale_quote_gives_no_spread(monkeypatch):
    from arbdesk import market, spreads
    now = time.time()
    q = dict(kind="perp", base="X", quote="USDT", volumeUsd=1e9, last=100.0, ts=1)
    monkeypatch.setattr(market, "quotes", {
        "a": {**q, "venue": "a", "symbol": "X/USDT:USDT", "bid": 99.0, "ask": 100.0, "seen": now},
        "b": {**q, "venue": "b", "symbol": "X/USDT:USDT", "bid": 101.0, "ask": 102.0, "seen": now},
    })
    assert spreads.build_cross()
    market.quotes["b"]["seen"] = now - 600
    assert spreads.build_cross() == []


class _Sock:
    def __init__(self):
        self.acks = []

    async def send_text(self, text):
        self.acks.append(json.loads(text))


class _Ex:
    def __init__(self):
        self.calls = []

    async def ws_place_order(self, *a, **k):
        self.calls.append(k)
        raise RuntimeError("stop")  # до биржи не идём


def _session(key_id, venue, demo):
    from arbdesk import trade
    s = trade.Session({"id": key_id, "venue": venue, "demo": demo}, "perp", _Ex(), None, None)
    trade._sessions[(key_id, "perp")] = s
    return s


def test_live_needs_confirm_and_key_choice():
    from arbdesk import trade
    trade._sessions.clear()
    live = _session("k1", "bybit", demo=False)
    order = {"type": "place", "venue": "bybit", "kind": "perp", "symbol": "X/USDT:USDT",
             "side": "buy", "price": 1, "notional": 10}
    sock = _Sock()
    asyncio.run(trade.handle(sock, order))
    assert not sock.acks[-1]["ok"] and "подтвержд" in sock.acks[-1]["text"] and not live.ex.calls
    asyncio.run(trade.handle(sock, {**order, "confirmLive": True}))
    assert live.ex.calls  # дошло до отправки

    demo = _session("k2", "bybit", demo=True)
    asyncio.run(trade.handle(sock, order))
    assert "выберите ключ" in sock.acks[-1]["text"]
    asyncio.run(trade.handle(sock, {**order, "keyId": "k2"}))
    assert demo.ex.calls and "ws" not in demo.ex.calls[-1]   # путь WS/REST выбирает bytx
    trade._sessions.clear()


def test_okx_orders_route_chosen_by_bytx():
    """bytx 0.2.6 шлёт instIdCode на OKX: терминал больше не форсирует REST."""
    from arbdesk import trade
    trade._sessions.clear()
    s = _session("k3", "okx", demo=True)
    asyncio.run(trade.handle(_Sock(), {"type": "place", "venue": "okx", "kind": "perp",
                                       "symbol": "X/USDT:USDT", "side": "buy", "price": 1, "notional": 10}))
    assert "ws" not in s.ex.calls[-1]
    trade._sessions.clear()


def test_inner_cancel_does_not_stop_polling():
    """ccxt отменяет свой запрос изнутри — цикл котировок должен жить дальше (раньше умирал молча)."""
    from arbdesk import market

    async def boom():
        raise asyncio.CancelledError()

    async def loop():
        for _ in range(3):
            await market._within(boom(), 1)
        return "alive"

    assert asyncio.run(loop()) == "alive"


def test_rest_snapshot_keeps_fresh_ws_price(monkeypatch):
    """Свежая WS-цена (best_bid_ask) не затирается более старым REST-снимком тикеров."""
    from types import SimpleNamespace as NS
    from arbdesk import market

    class Ex:
        async def markets(self, active_only=True):
            return [NS(symbol="X/USDT:USDT")]

        async def tickers(self):
            return [NS(symbol="X/USDT:USDT", last=100.0, bid=99.0, ask=101.0, quote_volume=5e6,
                       base_volume=0, timestamp=None)]

    monkeypatch.setattr(market, "quotes", {})
    monkeypatch.setattr(market, "_active", {})
    asyncio.run(market._poll_one("v", "perp", Ex()))
    key = market._key("v", "perp", "X/USDT:USDT")
    assert market.quotes[key]["bid"] == 99.0
    market.quotes[key].update(bid=100.4, ask=100.5, seen=time.time(), ws=True)
    asyncio.run(market._poll_one("v", "perp", Ex()))
    assert market.quotes[key]["bid"] == 100.4 and market.quotes[key]["volumeUsd"] == 5e6
    market.quotes[key]["seen"] = time.time() - 30  # WS замолчал — REST снова главный
    asyncio.run(market._poll_one("v", "perp", Ex()))
    assert market.quotes[key]["bid"] == 99.0


def test_views_filter_spreads_and_funding():
    from arbdesk import views
    row = {"base": "ZK", "quote": "USDT", "kind": "spot", "buyVenue": "binance", "sellVenue": "htx",
           "spreadPct": 1.2, "netPct": 1.1, "volumeUsd": 2e6}
    ok = lambda **m: views.spread_ok(row, views.parse(m))
    assert ok() and ok(q="ZK") and ok(q="bin") and not ok(q="BTC")
    assert ok(venues=["binance", "htx"]) and not ok(venues=["binance", "okx"])  # обе ноги в выбранных биржах
    assert ok(kind="spot") and not ok(kind="perp") and not ok(quote="USDC")
    assert not ok(minSpread=2) and not ok(minVol=5e6) and ok(netPos=True)
    assert views.parse({"venues": ["evil"], "minSpread": "nan", "kind": "x"})["venues"] == []
    f = {"base": "X", "quote": "USDT", "venue": "okx", "fundingPct": -0.05, "intervalH": 8.0, "volumeUsd": 1e7}
    fok = lambda **m: views.funding_ok(f, views.parse(m))
    assert fok(fundSign="-") and not fok(fundSign="+") and fok(fundPeriod=8) and not fok(fundPeriod=4)
    assert not fok(fundMin=0.1) and fok(fundMin=0.01)


def test_coin_venues_lists_all_exchanges(monkeypatch):
    from arbdesk import market, spreads
    now = time.time()
    q = dict(kind="perp", base="X", quote="USDT", last=100.0, ts=1, seen=now)
    monkeypatch.setattr(market, "quotes", {
        "a": {**q, "venue": "a", "symbol": "X/USDT:USDT", "bid": 99.0, "ask": 100.0, "volumeUsd": 1.0},  # мелкий объём — всё равно в списке
        "b": {**q, "venue": "b", "symbol": "X/USDT:USDT", "bid": 98.0, "ask": 98.5, "volumeUsd": 1e9},
        "c": {**q, "venue": "c", "symbol": "Y/USDT:USDT", "base": "Y", "bid": 1.0, "ask": 1.1, "volumeUsd": 1e9},
        "d": {**q, "venue": "d", "symbol": "X/USDT:USDT", "bid": 990.0, "ask": 1000.0, "volumeUsd": 1e9},  # другой X
    })
    rows = spreads.coin_venues("X", "USDT", "perp")
    assert [r["venue"] for r in rows] == ["b", "a", "d"]  # по возрастанию ask: дешевле купить — выше
    assert [r["odd"] for r in rows] == [False, False, True]


def test_fees_and_next_funding():
    from arbdesk import market, spreads
    market._taker.clear()
    market._taker[market._key("a", "perp", "X/USDT:USDT")] = 0.0005
    buy = {"venue": "a", "kind": "perp", "symbol": "X/USDT:USDT"}
    sell = {"venue": "b", "kind": "perp", "symbol": "X/USDT:USDT"}  # нет данных биржи → базовая 0.06%
    assert abs(spreads.fees_pct(buy, sell) - (0.05 + 0.06) * 2) < 1e-9
    # шорт на b получает 0.03, лонг на a платит 0.01; у a выплата позже — в ближайшую не входит
    pct, at = spreads.next_funding({"rate": 0.01, "next": 10_000_000}, {"rate": 0.03, "next": 1_000_000})
    assert at == 1_000_000 and abs(pct - 0.03) < 1e-9
    pct, _ = spreads.next_funding({"rate": 0.01, "next": 1_000_000}, {"rate": 0.03, "next": 1_000_000})
    assert abs(pct - 0.02) < 1e-9
    assert spreads.next_funding(None, None) == (None, None)
    market._taker.clear()


def test_exec_spread_walks_the_book():
    from arbdesk import depth
    asks = [(100.0, 1.0), (101.0, 10.0)]          # на 1000$ не хватает первого уровня
    bids = [(102.0, 5.0), (100.0, 10.0)]
    pct = depth.exec_pct(asks, bids, 1000)
    # купим 1 по 100 + 900/101 по 101, продадим 5 по 102 и остаток по 100
    qty = 1 + 900 / 101
    assert abs(pct - (5 * 102 + (qty - 5) * 100 - 1000) / 1000 * 100) < 1e-9
    assert depth.exec_pct(asks, bids, 1e6) is None      # стакана не хватает — не врём


def test_spread_life_resets_after_gap():
    from arbdesk import spreads
    spreads._life.clear()
    row = lambda: {"id": "x", "spreadPct": 1.0}
    r = row(); spreads.track_life([r], now=1000)
    r = row(); spreads.track_life([r], now=1020)
    assert r["ageSec"] == 20
    r = row(); spreads.track_life([r], now=1100)   # пропадал 80 с — новый спред
    assert r["ageSec"] == 0
    spreads._life.clear()


def test_transfer_status_and_filters():
    from arbdesk import transfers, views
    transfers._state.clear()
    transfers._state.update({"bin": {"ZK": (True, True)}, "htx": {"ZK": (False, False)}, "kc": {"ZK": (True, True)}})
    assert transfers.status("bin", "htx", "ZK") == ("blocked", "deposit", "htx")   # на HTX не завести
    assert transfers.status("htx", "kc", "ZK") == ("blocked", "withdraw", "htx")
    assert transfers.status("bin", "kc", "ZK")[0] == "ok"
    assert transfers.status("bin", "okx", "ZK")[0] == "unknown"
    nets = {"networks": {"a": {"deposit": False, "withdraw": False}, "b": {"deposit": True, "withdraw": False}}}
    assert transfers._flags(nets) == (True, False)       # открыта хоть одна сеть
    row = {"base": "ZK", "quote": "USDT", "kind": "spot", "buyVenue": "bin", "sellVenue": "htx",
           "spreadPct": 12.0, "netPct": 11.0, "volumeUsd": 2e6, "transfer": "blocked", "ageSec": 7200}
    assert views.spread_ok(row, views.parse({})) and not views.spread_ok(row, views.parse({"hideBlocked": True}))
    assert not views.spread_ok(row, views.parse({"maxAgeMin": 60})) and views.spread_ok(row, views.parse({"maxAgeMin": 180}))
    transfers._state.clear()


class _Bal:
    def __init__(self, free):
        self._free = free

    def free(self, ccy):
        return self._free.get(ccy, 0.0)


class _PairEx:
    """Фейковая биржа: IOC исполняет fill_ratio от размера по цене лимитки."""
    def __init__(self, fill_ratio=1.0, free=None):
        self.fill_ratio, self.sent, self._free = fill_ratio, [], free or {"USDT": 1000.0}
        self.step = 0.001

    async def balance(self):
        return _Bal(self._free)

    async def ws_place_order(self, symbol, side, *, size, price, type, time_in_force, reduce_only=False):
        from types import SimpleNamespace as NS
        self.sent.append((side, size, reduce_only))
        f = size * self.fill_ratio
        return NS(id=f"o{len(self.sent)}", status="canceled" if f < size else "closed", filled=f,
                  average=price, price=price, partial_info=False)

    async def order(self, symbol, order_id=None, client_id=None):
        raise AssertionError("не должен дочитывать: ответ полный")

    async def market(self, symbol):
        from types import SimpleNamespace as NS
        return NS(amount_step=self.step, contract_size=1.0)


def _pair_setup(monkeypatch, tmp_path, buy_fill=1.0, sell_fill=1.0):
    from arbdesk import arb_exec, market, trade
    monkeypatch.setattr(arb_exec, "_journal", [])
    monkeypatch.setattr(arb_exec, "_loaded", True)
    monkeypatch.setattr(arb_exec, "_push", lambda: asyncio.sleep(0))
    now = time.time()
    monkeypatch.setattr(market, "quotes", {
        "a|perp|X/USDT:USDT": {"venue": "a", "base": "X", "quote": "USDT", "bid": 99.0, "ask": 100.0, "seen": now},
        "b|perp|X/USDT:USDT": {"venue": "b", "base": "X", "quote": "USDT", "bid": 101.0, "ask": 102.0, "seen": now},
    })
    monkeypatch.setattr(arb_exec, "quotes", market.quotes)
    trade._sessions.clear()
    exa, exb = _PairEx(buy_fill), _PairEx(sell_fill, {"USDT": 300.0})
    trade._sessions[("ka", "perp")] = trade.Session({"id": "ka", "venue": "a", "demo": True}, "perp", exa, None, None)
    trade._sessions[("kb", "perp")] = trade.Session({"id": "kb", "venue": "b", "demo": True}, "perp", exb, None, None)
    msg = {"kind": "perp", "notional": 500, "buy": {"venue": "a", "symbol": "X/USDT:USDT"},
           "sell": {"venue": "b", "symbol": "X/USDT:USDT"}}
    return arb_exec, exa, exb, msg


def test_pair_open_caps_by_balance_and_closes(monkeypatch, tmp_path):
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    ok, text = asyncio.run(arb_exec.open_pair(msg))
    row = arb_exec.journal()[-1]
    assert ok and row["status"] == "open" and "урезано" in text           # 500 → 300*0.98 по балансу ноги b
    assert abs(row["notional"] - 294) < 1e-9 and exa.sent[0][1] == exb.sent[0][1]   # одинаково монет на обеих ногах
    assert abs(exa.sent[0][1] - 2.94) < 1e-9
    ok, _ = asyncio.run(arb_exec.close_pair({"id": row["id"]}))
    assert ok and row["status"] == "closed" and exa.sent[-1][2] and exb.sent[-1][2]  # закрытие reduce-only
    assert arb_exec.pnl(row)["pnl"] is not None


def test_pair_partial_needs_user_and_chase_fixes(monkeypatch, tmp_path):
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path, sell_fill=0.5)
    ok, text = asyncio.run(arb_exec.open_pair(msg))
    row = arb_exec.journal()[-1]
    assert row["status"] == "partial" and "перекос" in text
    assert len(exa.sent) == 1 and len(exb.sent) == 1          # сам ничего не досылает
    exb.fill_ratio = 1.0
    ok, _ = asyncio.run(arb_exec.fix_pair({"id": row["id"], "action": "chase"}))
    assert ok and row["status"] == "open" and exb.sent[-1][0] == "sell"


def test_pair_live_needs_confirm(monkeypatch, tmp_path):
    from arbdesk import trade
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    trade._sessions[("kb", "perp")].demo = False
    ok, text = asyncio.run(arb_exec.open_pair(msg))
    assert not ok and "подтвержд" in text and not exa.sent and not exb.sent
    trade._sessions.clear()


def test_pair_size_rounds_to_coarser_lot(monkeypatch, tmp_path):
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    exb.step = 1.0                       # у биржи продажи лот — целая монета
    asyncio.run(arb_exec.open_pair(msg))
    assert exa.sent[0][1] == exb.sent[0][1] == 2.0      # 2.94 → 2
    exb.step = 10.0
    ok, text = asyncio.run(arb_exec.open_pair(msg))
    assert not ok and "лота" in text


def test_watchlist_filter_and_alert(monkeypatch, tmp_path):
    from arbdesk import alerts, settings, telegram, views
    row = {"id": "zk", "base": "ZK", "quote": "USDT", "kind": "perp", "buyVenue": "binance", "sellVenue": "okx",
           "spreadPct": 0.2, "netPct": 0.15, "volumeUsd": 10.0, "buyAsk": 1, "sellBid": 1.002}
    assert views.spread_ok(row, views.parse({"only": ["zk"]})) and not views.spread_ok(row, views.parse({"only": ["BTC"]}))
    monkeypatch.setattr(settings, "FILE", tmp_path / "s.json")
    s = settings.save({"watch": ["zk", "zk", 5, "x" * 40], "watchNetPct": 0.1})
    assert s["watch"] == ["ZK"]  # из браузера — чистим
    sent = []
    monkeypatch.setattr(alerts, "_emit", sent.append)
    monkeypatch.setattr(telegram, "_sent", {})
    alerts.check_spreads([row])  # объём мал и спред ниже общего порога, но монета в избранном
    assert [a["kind"] for a in sent] == ["watch"]
    settings.save({"watch": []})


def test_funding_basis_uses_spot_of_same_venue(monkeypatch):
    from arbdesk import market, spreads
    now = time.time()
    q = dict(base="X", quote="USDT", ts=1, seen=now, bid=1.0, ask=1.0, volumeUsd=1e9)
    monkeypatch.setattr(market, "quotes", {
        "p": {**q, "venue": "a", "kind": "perp", "symbol": "X/USDT:USDT", "last": 101.0},
        "s": {**q, "venue": "a", "kind": "spot", "symbol": "X/USDT", "last": 100.0},
        "o": {**q, "venue": "b", "kind": "spot", "symbol": "X/USDT", "last": 50.0},  # чужая биржа — не база
    })
    monkeypatch.setattr(spreads, "funding_map", lambda: {})
    rows = spreads.build_funding()
    assert len(rows) == 1 and abs(rows[0]["basisPct"] - 1.0) < 1e-9


def _diary_tmp(monkeypatch, tmp_path):
    from arbdesk import diary, settings
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(diary, "_trades", None)
    monkeypatch.setattr(diary, "_pair_trades", lambda: [])
    return diary


def test_diary_pnl_long_short_fees_funding():
    from arbdesk import diary
    base = dict(openedAt="2026-11-01 10:00", closedAt="2026-11-01 12:00", symbol="BTC/USDT", qty=0.5, entry=100, exit=110)
    long_ = diary.clean({**base, "side": "buy", "fees": 1, "funding": -0.5})
    short = diary.clean({**base, "side": "short"})
    assert diary.pnl(long_) == 0.5 * 10 - 1 - 0.5
    assert diary.pnl(short) == -5
    assert diary.pnl(diary.clean({**base, "side": "long", "pnl": "-12,5"})) == -12.5  # готовый PnL из выгрузки
    opened = diary.clean({k: v for k, v in base.items() if k not in ("closedAt", "exit")} | {"side": "long"})
    assert opened["closedAt"] is None and diary.pnl(opened) is None and diary.pnl(opened, 120) == 10
    for bad in ({**base, "side": "up"}, {**base, "side": "long", "qty": -1}, {**base, "side": "long", "entry": "abc"},
                {**base, "side": "long", "closedAt": "2026-10-01"}):
        with pytest.raises(ValueError):
            diary.clean(bad)
    assert diary.split_symbol("ETH-USDT-SWAP") == ("ETH", "USDT") and diary.split_symbol("SOLUSDC") == ("SOL", "USDC")


def test_diary_report_kpis_and_drawdown():
    from arbdesk import diary
    day = 86_400_000
    rows = [diary.clean({"openedAt": i * day, "closedAt": i * day + 1000, "symbol": "X/USDT", "side": "long",
                         "qty": 1, "entry": 100, "pnl": p, "strategy": s})
            for i, (p, s) in enumerate([(10, "trend"), (-4, "trend"), (-6, "spread"), (20, "spread"), (5, "trend")], 1)]
    r = diary.report(rows)
    k = r["kpi"]
    assert k["pnl"] == 25 and k["trades"] == 5 and k["winRate"] == 60
    assert k["profitFactor"] == 35 / 10 and k["maxDrawdown"] == 10  # пик 10 → дно 0
    assert k["winStreak"] == 2 and k["lossStreak"] == 2
    assert [p for _ts, p in r["equity"]] == [10, 6, 0, 20, 25]
    assert {g["key"]: g["pnl"] for g in r["byStrategy"]} == {"trend": 11, "spread": 14}
    assert diary.report(rows[:1])["kpi"]["profitFactor"] is None  # без убытков — не бесконечность в JSON


def test_diary_csv_import_formats_and_dedup(monkeypatch, tmp_path):
    diary = _diary_tmp(monkeypatch, tmp_path)
    bybit = ("Contracts,Side,Qty,Entry Price,Exit Price,Closed P&L,Trade Time\n"
             "BTCUSDT,Sell,0.01,90000,91000,9.5,2026-11-20 10:00:00\n"
             "ETHUSDT,Buy,1,3000,2900,100,2026-11-21 10:00:00\n"
             "BADUSDT,Sell,x,1,1,1,2026-11-21\n")
    r = diary.import_csv(bybit)
    assert r["added"] == 2 and len(r["errors"]) == 1 and "строка 4" in r["errors"][0]
    assert diary.import_csv(bybit)["skipped"] == 2  # повторный импорт без дублей
    ru = "﻿Дата;Пара;Направление;Количество;Цена входа;Цена выхода;Комиссия\n01.11.2026 10:00;SOL/USDT;лонг;2;150,5;160;0,4\n"
    r = diary.import_csv(ru)
    assert r["added"] == 1, r
    sol = next(t for t in diary.trades() if t["base"] == "SOL")
    assert sol["entry"] == 150.5 and sol["closedAt"] == sol["openedAt"] and abs(diary.pnl(sol) - (2 * 9.5 - 0.4)) < 1e-9
    assert diary.import_csv("a,b\n1,2\n")["errors"]
    back = diary.export_csv(diary.trades())
    diary.trades().clear()
    assert diary.import_csv(back)["added"] == 3  # свой экспорт читается обратно
    saved = json.loads((tmp_path / "trades.json").read_text())
    assert len(saved) == 3


def test_diary_api(monkeypatch, tmp_path):
    _diary_tmp(monkeypatch, tmp_path)
    from arbdesk import main
    c = TestClient(main.app, base_url="http://127.0.0.1")
    t = {"openedAt": "2026-11-02T10:00:00Z", "closedAt": "2026-11-02T11:00:00Z", "symbol": "BTC/USDT",
         "side": "long", "qty": 1, "entry": 100, "exit": 103, "fees": 1, "strategy": "Trend", "venue": "Bybit"}
    tid = c.post("/api/diary", json=t).json()["trade"]["id"]
    assert c.post("/api/diary", json={**t, "qty": 0}).status_code == 400
    v = c.get("/api/diary").json()
    assert v["report"]["kpi"]["pnl"] == 2 and v["options"]["strategies"] == ["trend"] and v["options"]["venues"] == ["bybit"]
    assert c.get("/api/diary", params={"strategy": "spread"}).json()["total"] == 0
    assert "BTC" in c.get("/api/diary/export.csv").text
    assert c.delete(f"/api/diary/{tid}").json()["ok"] and c.get("/api/diary").json()["total"] == 0


def test_pair_double_close_sends_once(monkeypatch, tmp_path):
    """Двойной клик «Закрыть»: второе закрытие не должно отправить ордера повторно (на споте открыло бы позицию)."""
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    asyncio.run(arb_exec.open_pair(msg))
    row = arb_exec.journal()[-1]
    for ex in (exa, exb):
        orig = ex.ws_place_order

        async def slow(*a, _orig=orig, **k):
            await asyncio.sleep(0.01)  # ответ биржи идёт не мгновенно
            return await _orig(*a, **k)
        ex.ws_place_order = slow
    n = len(exa.sent), len(exb.sent)

    async def twice():
        return await asyncio.gather(arb_exec.close_pair({"id": row["id"]}), arb_exec.close_pair({"id": row["id"]}),
                                    arb_exec.fix_pair({"id": row["id"], "action": "unwind"}))
    res = asyncio.run(twice())
    assert (len(exa.sent) - n[0], len(exb.sent) - n[1]) == (1, 1)
    assert res[0][0] and not res[1][0] and row["status"] == "closed"


def _close_setup(monkeypatch, pos):
    from types import SimpleNamespace as NS
    from arbdesk import trade
    sent, acks = [], []

    class Ex:
        async def ws_place_order(self, symbol, side, **k):
            await asyncio.sleep(0.01)
            sent.append((side, k))
            return NS(side=side, symbol=symbol, price=k.get("price"), id="1", raw={})
    s = trade.Session({"id": "k", "venue": "bybit", "demo": True}, "perp", Ex(), None, NS(get=lambda *a: pos))
    monkeypatch.setitem(trade._sessions, ("k", "perp"), s)

    async def ack(_sock, ok, text):
        acks.append((ok, text))

    async def nop(*a):
        return None
    monkeypatch.setattr(trade, "_ack", ack)
    monkeypatch.setattr(trade, "push_orders", nop)
    monkeypatch.setattr(trade, "push_positions", nop)
    monkeypatch.setattr(trade, "_remember", lambda *a: None)
    monkeypatch.setattr(trade, "_reconcile", nop)
    from arbdesk import integrity
    monkeypatch.setattr(integrity, "gate", lambda *a: asyncio.sleep(0, result=None))
    return trade, sent, acks, {"venue": "bybit", "kind": "perp", "keyId": "k", "symbol": "X/USDT:USDT"}


def test_partial_close_once_and_gone(monkeypatch):
    from types import SimpleNamespace as NS
    pos = NS(size=2.0, side="long", contracts=None)
    trade, sent, acks, base = _close_setup(monkeypatch, pos)

    async def twice():
        await asyncio.gather(trade.handle(None, {**base, "type": "close", "fraction": 0.5}),
                             trade.handle(None, {**base, "type": "close", "fraction": 0.5}))
    asyncio.run(twice())
    assert len(sent) == 1 and sent[0][0] == "sell" and sent[0][1]["size"] == 1.0 and sent[0][1]["reduce_only"]
    assert sorted(ok for ok, _ in acks) == [False, True] and any("50%" in t for _, t in acks)
    asyncio.run(trade.handle(None, {**base, "type": "close", "fraction": 1.5}))
    assert acks[-1][0] is False and len(sent) == 1                          # доля > 100% не уходит
    asyncio.run(trade.handle(None, {**base, "type": "close", "orderType": "limit", "price": 101, "fraction": 0.25}))
    assert sent[-1][1] == {"reduce_only": True, "size": 0.5, "price": 101.0, "type": "limit"}


def test_close_reports_position_gone(monkeypatch):
    from types import SimpleNamespace as NS
    pos = NS(size=1.0, side="short", contracts=None)
    trade, sent, acks, base = _close_setup(monkeypatch, pos)

    class Gone(type(trade._sessions[("k", "perp")].ex)):
        async def ws_place_order(self, symbol, side, **k):
            raise errors.PositionAlreadyClosed("110017")
    trade._sessions[("k", "perp")].ex = Gone()
    asyncio.run(trade.handle(None, {**base, "type": "close"}))
    assert acks[-1] == (False, "позиции на бирже уже нет")


def test_market_order_needs_no_price(monkeypatch):
    from types import SimpleNamespace as NS
    trade, sent, acks, base = _close_setup(monkeypatch, NS(size=0, side=None, contracts=None))
    asyncio.run(trade.handle(None, {**base, "type": "place", "side": "buy", "orderType": "market", "notional": 50}))
    assert sent[-1][1] == {"notional": 50.0, "type": "market"} and acks[-1][0]
    asyncio.run(trade.handle(None, {**base, "type": "place", "side": "buy", "notional": 50}))
    assert acks[-1] == (False, "нужны сторона, цена и сумма") and len(sent) == 1


def test_pair_leg_closed_outside_and_dismiss(monkeypatch, tmp_path):
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    asyncio.run(arb_exec.open_pair(msg))
    row = arb_exec.journal()[-1]

    async def gone(*a, **k):
        raise errors.PositionAlreadyClosed("closed by hand")
    exb.ws_place_order = gone                      # ногу продажи закрыли руками на бирже
    ok, text = asyncio.run(arb_exec.close_pair({"id": row["id"]}))
    sell = next(l for l in row["legs"] if l["role"] == "sell")
    assert ok and row["status"] == "closed" and sell["exit"]["outside"] and sell["exit"]["avg"] == 101.5
    assert arb_exec.pnl(row)["pnl"] is not None and "ошиб" not in text

    asyncio.run(arb_exec.open_pair(msg))           # вторая связка: обе ноги закрыли вне терминала
    row2 = arb_exec.journal()[-1]
    n = len(exa.sent)
    ok, _ = asyncio.run(arb_exec.dismiss_pair({"id": row2["id"]}))
    assert ok and row2["status"] == "closed" and row2["outside"] and len(exa.sent) == n   # без ордеров
    assert all(l["exit"]["outside"] for l in row2["legs"])
    row2["status"] = "failed"                       # неудавшаяся связка — просто убрать из журнала
    ok, _ = asyncio.run(arb_exec.dismiss_pair({"id": row2["id"]}))
    assert ok and all(r["id"] != row2["id"] for r in arb_exec.public_rows())


def test_bingx_demo_vst_counts_as_usdt(monkeypatch, tmp_path):
    """Демо BingX держит деньги в VST: связка не должна отказывать «мало средств»."""
    arb_exec, exa, exb, msg = _pair_setup(monkeypatch, tmp_path)
    exb._free = {"VST": 1000.0}
    ok, text = asyncio.run(arb_exec.open_pair(msg))
    assert ok and "мало средств" not in text


def test_new_tab_gets_positions_snapshot(monkeypatch):
    from types import SimpleNamespace as NS
    from arbdesk import trade
    pos = NS(symbol="X/USDT:USDT", side="long", size=2.0, entry_price=1.0, unrealized_pnl=0.1, leverage=5, liquidation_price=None)
    s = trade.Session({"id": "k", "venue": "bybit", "demo": True}, "perp", None, NS(open_orders=[]), NS(positions=[pos]))
    monkeypatch.setattr(trade, "_sessions", {("k", "perp"): s})
    msgs = trade.snapshot()
    assert [m["type"] for m in msgs] == ["orders", "positions"] and msgs[1]["rows"][0]["size"] == 2.0
