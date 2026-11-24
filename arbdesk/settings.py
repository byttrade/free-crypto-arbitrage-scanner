from __future__ import annotations

import json
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
FILE = DATA_DIR / "settings.json"

DEFAULTS = {
    "telegramToken": "",
    "telegramChatId": "",
    "minSpreadPct": 0.35,
    "velocityPct": 0.12,
    "velocityWindowSec": 20,
    "cooldownSec": 180,
    "minVolumeUsd": 500_000,
    "minFundingPct": 0.08,
    "slippagePct": 0.05,  # запас на проскальзывание сверх комиссий бирж, на всю связку
    "sizeUsd": 1000,  # объём для «спреда на объём» по стакану
    "corrMin": 0.75,
    "zEntry": 2.0,
    "zExit": 0.5,
    "tgMaxPerMin": 12,
    "maxQuoteAgeSec": 60,
    "watch": [],  # избранные монеты: алерт по ним с порогом watchNetPct, без фильтра объёма
    "watchNetPct": 0.1,
    "autoUpdate": "on",  # bytx и сама панель: on | notify | off
}

MASK = "••••"

_current = dict(DEFAULTS)


def get() -> dict:
    return dict(_current)


def public() -> dict:
    """Для браузера: токен бота не отдаём, только хвост."""
    out = get()
    token = out["telegramToken"]
    out["telegramToken"] = MASK + token[-4:] if token else ""
    return out


def load() -> dict:
    global _current
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if FILE.exists():
        _current = {**DEFAULTS, **json.loads(FILE.read_text(encoding="utf-8"))}
    return get()


def save(patch: dict) -> dict:
    global _current
    patch = {k: v for k, v in patch.items() if k in DEFAULTS}
    if str(patch.get("telegramToken", "")).startswith(MASK):
        patch.pop("telegramToken")  # из UI вернулась маска — токен не менялся
    if "watch" in patch:
        w = patch["watch"] if isinstance(patch["watch"], list) else []
        patch["watch"] = list(dict.fromkeys(str(x).strip().upper() for x in w if isinstance(x, str) and 0 < len(x.strip()) <= 24))[:200]
    if patch.get("autoUpdate") not in (None, "on", "notify", "off"):
        patch.pop("autoUpdate")
    _current = {**_current, **patch}
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(_current, indent=2), encoding="utf-8")
    return get()
