"""Auto-update of bytx and of ArbDesk itself, without touching open positions.

The same scheme as in free-crypto-trading-bot (trend4h/update.py), extended to this package:
once a day the PyPI index is asked; the newest version inside the allowed range is installed into this environment,
verified in a separate process (files against the wheel RECORD, imports, an exchange object without network,
broker attribution sources), and the server restarts itself in the same process (os.execv).
Any failure: the previous version is put back and verified, the same version is not tried again for a day.

What keeps positions safe:
- nothing here closes, cancels or sends orders: positions, limit orders and stops stay on the exchanges;
- the update starts only in a quiet window: no order in flight and none sent in the last QUIET_SEC;
- from the moment the install starts new orders are refused until the restart, and the restart waits for
  in-flight orders to finish;
- the pair journal and the diary are on disk (atomic writes); opened exchange keys are handed to the new process
  through an inherited pipe, so trading sessions come back without re-entering the secret.

An auto-update installs code from PyPI into a process that holds exchange keys. Set "Auto-update" to
"notify" or "off" in the panel if you prefer to update by hand.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from importlib import metadata
from pathlib import Path

from . import DIST, __version__

CHECK_EVERY = 24 * 3600
QUIET_SEC = 120          # no update within this long after the last order
DRAIN_SEC = 60           # how long the restart waits for in-flight orders
HANDOFF_ENV = "ARBDESK_HANDOFF_FD"


def parse(version: str):
    """'0.2.10' -> (0, 2, 10); None for pre-releases and anything unusual."""
    parts = (version or "").split(".")
    return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else None


# name -> (lowest allowed, upper bound exclusive). bytx: same range as in pyproject.toml.
# ArbDesk: any newer 0.x; a 1.0 is announced, not installed.
RANGES = {"bytx": ((0, 2, 6), (0, 3)), DIST: (parse(__version__) or (0,), (1,))}


def pick(versions, low, below) -> tuple[str | None, str | None]:
    """(newest version inside [low, below), newest version at or above `below`)."""
    parsed = sorted((v, s) for s in versions if (v := parse(s)))
    inside = [s for v, s in parsed if low <= v and v[:len(below)] < below]
    beyond = [s for v, s in parsed if v[:len(below)] >= below]
    return (inside[-1] if inside else None), (beyond[-1] if beyond else None)


def pypi_versions(name: str) -> list[str]:
    req = urllib.request.Request(f"https://pypi.org/pypi/{name}/json", headers={"User-Agent": "arbdesk-update"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return list(json.load(r)["releases"])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []  # not published (yet)
        raise


def installed(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def self_updatable() -> bool:
    """ArbDesk updates itself only when it runs from an installed wheel (not from a source checkout)."""
    try:
        dist = metadata.distribution(DIST)
    except metadata.PackageNotFoundError:
        return False
    hashed = any(str(f).startswith("arbdesk/") and getattr(f, "hash", None) for f in dist.files or [])
    return hashed and Path(dist.locate_file("arbdesk")).resolve() == Path(__file__).resolve().parent


def pip_install(name: str, version: str) -> None:
    """Install name==version into this environment; RuntimeError with the installer's last lines on failure."""
    spec = f"{name}=={version}"
    if importlib.util.find_spec("pip"):
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", spec]
    elif shutil.which("uv"):
        cmd = ["uv", "pip", "install", "--python", sys.executable, spec]
    else:
        raise RuntimeError("neither pip nor uv is available in this environment: update by hand")
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if out.returncode:
        raise RuntimeError(f"installer failed: {(out.stderr or out.stdout).strip()[-300:]}")


_VERIFY = ("import json; from arbdesk import integrity; "
           "integrity.check_files('bytx'); import bytx, arbdesk.main; "
           "from bytx.net._sig import opts; bytx.create_exchange('bybit'); "
           "print(json.dumps({'bytx': bytx.__version__, 'sources': opts.sources(sorted(opts.KEYS))}))")


def verify_install(name: str, version: str) -> dict:
    """Check the environment in a separate process after installing name==version; returns attribution sources."""
    out = subprocess.run([sys.executable, "-c", _VERIFY], capture_output=True, text=True, timeout=180)
    if out.returncode:
        raise RuntimeError(f"verification failed: {out.stderr.strip()[-300:]}")
    info = json.loads(out.stdout.strip().splitlines()[-1])
    now = info["bytx"] if name == "bytx" else installed(name)
    if now != version:
        raise RuntimeError(f"installed {name} is {now}, expected {version}")
    return info["sources"]


# ---------- order activity: the update waits for a quiet window ----------

busy = 0
last_order = 0.0
updating = False  # install started: new orders are refused until the restart


@asynccontextmanager
async def activity():
    global busy, last_order
    busy += 1
    try:
        yield
    finally:
        busy -= 1
        last_order = time.time()


def safe_window(now: float | None = None) -> str | None:
    """None if it is safe to update now, otherwise why not."""
    now = time.time() if now is None else now
    if busy:
        return "an order is being sent"
    if now - last_order < QUIET_SEC:
        return f"an order was sent less than {QUIET_SEC // 60} min ago"
    return None


class Updater:
    def __init__(self, state_dir, mode="on", log=print, versions=pypi_versions, install=pip_install,
                 verify=verify_install, current=installed, clock=time.time, own_updatable=self_updatable):
        self.mode, self.log, self.versions, self.install, self.verify = mode, log, versions, install, verify
        self.current, self.clock, self.own_updatable = current, clock, own_updatable
        self.file = Path(state_dir) / "update.json"
        try:
            self.st = json.loads(self.file.read_text())
        except (OSError, ValueError):
            self.st = {}
        self.st.setdefault("checked_at", 0)
        self.st.setdefault("pkgs", {})
        self.st.setdefault("failed", {})
        self.force = False   # "update now": skips the daily timer, never the quiet window
        self.last = self.st.get("last")  # last event, for the panel (survives the restart)

    def _save(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.st))
        tmp.replace(self.file)

    def _event(self, ev: str, **kw):
        self.last = self.st["last"] = {"event": ev, "at": self.clock(), **kw}
        self._save()
        self.log("update", ev, kw)

    def _managed(self, name: str) -> bool:
        return name == "bytx" or self.own_updatable()

    def status(self) -> dict:
        pkgs = []
        for name, (low, below) in RANGES.items():
            p = self.st["pkgs"].get(name, {})
            pkgs.append({"name": name, "current": self.current(name), "available": p.get("available"),
                         "incompatible": p.get("incompatible"), "auto": self._managed(name)})
        return {"mode": self.mode, "checkedAt": self.st["checked_at"], "packages": pkgs, "last": self.last}

    def check(self) -> tuple[str, str] | None:
        """Ask the index once a day; returns (package, version) to install now, if any."""
        if self.mode == "off":
            return None
        now = self.clock()
        if self.force or now - self.st["checked_at"] >= CHECK_EVERY:
            for name, (low, below) in RANGES.items():
                prev = self.st["pkgs"].get(name, {})
                try:
                    inside, beyond = pick(self.versions(name), low, below)
                except Exception as e:
                    self._event("check_failed", package=name, error=str(e)[:200])
                    continue
                cur = parse(self.current(name) or "")
                newer = inside if inside and cur and parse(inside) > cur else None
                if newer and newer != prev.get("available"):
                    self._event("available", package=name, version=newer)
                if beyond and beyond != prev.get("incompatible"):
                    self._event("incompatible", package=name, version=beyond)
                self.st["pkgs"][name] = {"available": newer, "incompatible": beyond}
            self.st["checked_at"] = now
            self._save()
        if self.mode != "on":
            return None
        for name in RANGES:  # bytx first: a new ArbDesk may need it
            v = self.st["pkgs"].get(name, {}).get("available")
            if v and self._managed(name) and now - self.st["failed"].get(f"{name}=={v}", 0) >= CHECK_EVERY:
                return name, v
        return None

    def run(self, safe=safe_window) -> str | None:
        """One pass. Returns 'restart' after a successful update (the caller restarts before any new order)."""
        global updating
        target = self.check()
        if not target:
            self.force = False
            return None
        if wait := safe():
            if self.force:
                self._event("postponed", reason=wait)
            return None
        self.force = False
        name, version = target
        old = self.current(name)
        updating = True
        self._event("start", package=name, current=old, version=version)
        try:
            before = self.verify(name, old)
            self.install(name, version)
            after = self.verify(name, version)
            lost = sorted(k for k, s in before.items() if s == "builtin" and after.get(k) != "builtin")
            if lost:
                raise RuntimeError(f"attribution sources changed after the update: {', '.join(lost)}")
        except Exception as e:
            self.st["failed"][f"{name}=={version}"] = self.clock()
            self._save()
            self._event("failed", package=name, version=version, error=str(e)[:300])
            try:
                self.install(name, old)
                self.verify(name, old)
                self._event("rolled_back", package=name, version=old)
            except Exception as e2:  # the integrity gate decides whether new orders go out
                self._event("rollback_failed", package=name, version=old, error=str(e2)[:300])
            updating = False
            return None
        self.st["pkgs"][name]["available"] = None
        self._save()
        self._event("done", package=name, version=version)
        return "restart"


# ---------- restart in the same process, keys handed over through a pipe ----------

server = None            # uvicorn.Server when started with `python -m arbdesk`; None: restart is not possible
restart_requested = False


def can_restart() -> bool:
    return server is not None


def request_restart() -> None:
    global restart_requested
    restart_requested = True
    server.should_exit = True


def exec_again(handoff: dict) -> None:
    """Replace this process with a fresh one that loads the new files; `handoff` reaches it through a pipe."""
    data = json.dumps(handoff).encode()
    if handoff and len(data) < 60_000:  # a pipe holds at least 64 KB: the write never blocks
        r, w = os.pipe()
        os.write(w, data)
        os.close(w)
        os.set_inheritable(r, True)
        os.environ[HANDOFF_ENV] = str(r)
    os.execv(sys.executable, [sys.executable, "-m", "arbdesk", *sys.argv[1:]])


def take_handoff() -> dict:
    """What the previous process handed over (once); {} if nothing."""
    fd = os.environ.pop(HANDOFF_ENV, None)
    if not fd:
        return {}
    try:
        with os.fdopen(int(fd), "rb") as f:
            return json.loads(f.read() or b"{}")
    except (OSError, ValueError):
        return {}
