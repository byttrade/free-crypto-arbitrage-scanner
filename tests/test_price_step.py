import asyncio
from types import SimpleNamespace

from ccxt.base.decimal_to_precision import DECIMAL_PLACES, TICK_SIZE

from arbdesk import market


def _fake(mode, step, calls):
    async def get(symbol):
        calls.append(symbol)
        return SimpleNamespace(price_step=step)
    return SimpleNamespace(market=get, _ex=SimpleNamespace(precisionMode=mode))


def test_price_step_cached_and_only_ticks(monkeypatch):
    calls = []
    monkeypatch.setattr(market, "_steps", {})
    monkeypatch.setattr(market, "client", lambda v, k: _fake(TICK_SIZE, 0.0001, calls))
    assert asyncio.run(market.price_step("bitget", "DOGE/USDT:USDT", "perp")) == 0.0001
    assert asyncio.run(market.price_step("bitget", "DOGE/USDT:USDT", "perp")) == 0.0001
    assert calls == ["DOGE/USDT:USDT"]  # второй раз — из кэша
    # Знаки после запятой / значащие цифры (Hyperliquid) — не шаг, отдаём None.
    monkeypatch.setattr(market, "client", lambda v, k: _fake(DECIMAL_PLACES, 4, calls))
    assert asyncio.run(market.price_step("hyperliquid", "DOGE/USDC:USDC", "perp")) is None
