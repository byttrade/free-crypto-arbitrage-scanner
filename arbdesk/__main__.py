"""`python -m arbdesk` (или команда `arbdesk`): сервер панели с самообновлением.

После обновления bytx или ArbDesk процесс перезапускает сам себя (os.execv) и передаёт новому
открытые ключи через pipe — торговля продолжается без повторного ввода секрета.
"""
from __future__ import annotations

import argparse
import os


def main() -> None:
    import uvicorn

    from . import update, vault

    p = argparse.ArgumentParser(prog="arbdesk")
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8780")))
    a = p.parse_args()
    server = uvicorn.Server(uvicorn.Config("arbdesk.main:app", host=a.host, port=a.port))
    update.server = server
    server.run()
    if update.restart_requested:
        update.exec_again(vault.handoff())


if __name__ == "__main__":
    main()
