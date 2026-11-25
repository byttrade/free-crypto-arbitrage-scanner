"""Auto-update of bytx and ArbDesk with a fake index and installer: no network, nothing is installed."""
import asyncio
import os
import pathlib

import pytest

from arbdesk import DIST, update, vault

SOURCES = {"BYBIT_BROKER_ID": "builtin", "BINANCE_BROKER_ID_FUTURES": "none"}
CALM = lambda: None  # noqa: E731


@pytest.fixture(autouse=True)
def _installed_0_1_0(monkeypatch):
    """Фейковый мир считает установленной 0.1.0 — диапазон обновлений от неё, а не от текущей версии пакета."""
    monkeypatch.setitem(update.RANGES, DIST, ((0, 1, 0), (1,)))


class World:
    def __init__(self, tmp_path, index=None, own=True, **kw):
        self.ver = {"bytx": "0.2.6", DIST: "0.1.0"}
        self.index = index or {"bytx": ["0.2.6", "0.2.9", "0.3.0", "0.2.10rc1"], DIST: ["0.1.0", "0.1.2", "1.0.0"]}
        self.calls, self.events, self.broken = [], [], set()
        self.up = update.Updater(tmp_path, versions=lambda n: list(self.index.get(n, [])), install=self.install,
                                 verify=self.verify, current=lambda n: self.ver.get(n), clock=lambda: 1e9,
                                 log=lambda _, ev, kw: self.events.append(ev), own_updatable=lambda: own, **kw)

    def install(self, name, version):
        self.calls.append(f"{name}=={version}")
        if f"{name}=={version}" in self.broken:
            raise RuntimeError("no matching distribution")
        self.ver[name] = version

    def verify(self, name, version):
        return dict(SOURCES)


def test_ranges_match_pyproject_and_pick_stays_inside():
    assert update.pick(["0.2.6", "0.2.10", "0.2.9", "0.3.0", "0.2.11rc1"], (0, 2, 6), (0, 3)) == ("0.2.10", "0.3.0")
    toml = (pathlib.Path(__file__).parent.parent / "pyproject.toml").read_text()
    assert '"bytx[ws]>=0.2.6,<0.3"' in toml and update.RANGES["bytx"] == ((0, 2, 6), (0, 3))
    assert f'name = "{DIST}"' in toml


def test_bytx_first_then_the_panel_each_with_a_restart(tmp_path):
    w = World(tmp_path)
    assert w.up.run(CALM) == "restart" and w.calls == ["bytx==0.2.9"]
    update.updating = False                       # a fresh process after the restart
    assert w.up.run(CALM) == "restart" and w.calls[-1] == f"{DIST}==0.1.2"
    update.updating = False
    assert w.up.run(CALM) is None                 # 0.3.0 and 1.0.0 are only announced
    st = {p["name"]: p for p in w.up.status()["packages"]}
    assert st["bytx"]["incompatible"] == "0.3.0" and st[DIST]["incompatible"] == "1.0.0"


def test_source_checkout_never_updates_itself(tmp_path):
    w = World(tmp_path, index={"bytx": ["0.2.6"], DIST: ["0.1.0", "0.1.5"]}, own=False)
    assert w.up.run(CALM) is None and w.calls == [] and "available" in w.events


def test_failure_rolls_back_and_waits_a_day(tmp_path):
    w = World(tmp_path)
    w.broken.add("bytx==0.2.9")
    assert w.up.run(CALM) is None and w.calls == ["bytx==0.2.9", "bytx==0.2.6"] and w.ver["bytx"] == "0.2.6"
    assert w.events[-2:] == ["failed", "rolled_back"] and update.updating is False
    # the same bytx is not retried today; the panel update is not held back by it
    assert w.up.run(CALM) == "restart" and w.calls[-1] == f"{DIST}==0.1.2"
    update.updating = False


def test_lost_attribution_is_rolled_back(tmp_path):
    w = World(tmp_path)
    w.up.verify = lambda n, v: {**SOURCES, **({"BYBIT_BROKER_ID": "none"} if v == "0.2.9" else {})}
    assert w.up.run(CALM) is None and w.ver["bytx"] == "0.2.6"


def test_waits_for_a_quiet_window_and_modes(tmp_path):
    w = World(tmp_path)
    assert w.up.run(lambda: "an order is being sent") is None and w.calls == []
    update.busy, update.last_order = 0, 1000.0
    assert "less than" in update.safe_window(now=1000.0 + 60) and update.safe_window(now=1000.0 + 121) is None
    update.busy = 1
    assert "being sent" in update.safe_window(now=5000.0)
    update.busy = 0
    n = World(tmp_path / "n", mode="notify")
    assert n.up.run(CALM) is None and n.calls == [] and "available" in n.events
    o = World(tmp_path / "o", mode="off")
    assert o.up.run(CALM) is None and o.events == []


def test_activity_counts_orders():
    async def go():
        async with update.activity():
            assert update.busy == 1
    update.busy = 0
    asyncio.run(go())
    assert update.busy == 0 and update.last_order > 0


def test_keys_survive_the_restart_through_a_pipe(monkeypatch):
    monkeypatch.setattr(vault, "_rows", [{"id": "a"}, {"id": "b"}])
    monkeypatch.setattr(vault, "_open", {"a": {"apiKey": "k", "secret": "s", "password": ""}})
    data = vault.handoff()
    r, w = os.pipe()
    os.write(w, __import__("json").dumps(data).encode())
    os.close(w)
    monkeypatch.setenv(update.HANDOFF_ENV, str(r))
    monkeypatch.setattr(vault, "_open", {})
    got = update.take_handoff()
    assert update.HANDOFF_ENV not in os.environ and update.take_handoff() == {}
    got["open"]["zzz"] = {"apiKey": "x"}                          # unknown key ids are ignored
    assert vault.restore(got) and vault._open == {"a": {"apiKey": "k", "secret": "s", "password": ""}}
