"""Команда `arbdesk` (или `python -m arbdesk`).

  arbdesk                  панель на http://127.0.0.1:8780, браузер откроется сам
  arbdesk --public         доступ извне: все адреса, HTTPS (свой сертификат), вход по логину и паролю;
                           ссылка для создания учётной записи печатается здесь
  arbdesk --public --http  то же за своим HTTPS-прокси (nginx, Caddy, Cloudflare Tunnel)
  arbdesk reset-password   новый пароль (и логин) из терминала сервера; все входы сбрасываются

После обновления bytx или ArbDesk процесс перезапускает сам себя (os.execv) и передаёт новому
открытые ключи через pipe — торговля продолжается без повторного ввода секрета.
"""
from __future__ import annotations

import argparse
import datetime
import getpass
import ipaddress
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ON = ("1", "true", "yes", "on")


def _lan_ip() -> str | None:
    """Адрес этой машины в сети (без отправки пакетов)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return None


def _self_signed(folder: Path) -> tuple[str, str]:
    """Свой сертификат для HTTPS (браузер один раз предупредит). Создаётся один раз, лежит в DATA_DIR/tls."""
    cert, key = folder / "cert.pem", folder / "key.pem"
    if cert.exists() and key.exists():
        return str(cert), str(key)
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    folder.mkdir(parents=True, exist_ok=True)
    pk = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ArbDesk")])
    alt = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname()), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    if ip := _lan_ip():
        alt.append(x509.IPAddress(ipaddress.ip_address(ip)))
    now = datetime.datetime.now(datetime.timezone.utc)
    crt = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(pk.public_key())
           .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
           .not_valid_after(now + datetime.timedelta(days=3650))
           .add_extension(x509.SubjectAlternativeName(alt), critical=False).sign(pk, hashes.SHA256()))
    key.write_bytes(pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()))
    os.chmod(key, 0o600)
    cert.write_bytes(crt.public_bytes(serialization.Encoding.PEM))
    return str(cert), str(key)


def reset_password() -> None:
    from . import auth
    acc = auth.account()
    user = input(f"Login [{acc['user']}]: " if acc else "Login: ").strip() or (acc or {}).get("user", "")
    while True:
        p1 = getpass.getpass("New password: ")
        p2 = getpass.getpass("Repeat password: ")
        if p1 != p2:
            print("Passwords do not match, try again.")
            continue
        try:
            auth.save_account(user, p1)
            break
        except ValueError as e:
            print(e)
    print(f"Done: login '{user}' has a new password. Every device is signed out. No restart needed.")


def main() -> None:
    p = argparse.ArgumentParser(prog="arbdesk", description="ArbDesk: crypto arbitrage terminal & trading journal")
    p.add_argument("command", nargs="?", choices=["run", "reset-password"], default="run")
    p.add_argument("--public", action="store_true", default=os.environ.get("ARBDESK_PUBLIC", "").lower() in ON,
                   help="доступ извне: все адреса, HTTPS и вход по паролю")
    p.add_argument("--http", action="store_true", default=os.environ.get("ARBDESK_TLS", "").lower() == "off",
                   help="без своего HTTPS (за nginx / Caddy / Cloudflare Tunnel)")
    p.add_argument("--host", default=os.environ.get("HOST"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8780")))
    p.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    a = p.parse_args()
    if a.command == "reset-password":
        reset_password()
        return

    import uvicorn

    from . import auth, settings, update, vault

    host = a.host or ("0.0.0.0" if a.public else "127.0.0.1")
    tls = {}
    if a.public:
        auth.public = True
        os.environ["ARBDESK_PUBLIC"] = "1"  # перезапуск после самообновления — в том же режиме
        if not a.http:
            cert, key = _self_signed(settings.DATA_DIR / "tls")
            tls = {"ssl_certfile": cert, "ssl_keyfile": key}
    scheme = "https" if tls else "http"
    url = f"{scheme}://127.0.0.1:{a.port}"
    if a.public:
        ip = None if Path("/.dockerenv").exists() else _lan_ip()  # в Docker свой адрес контейнера бесполезен
        where = f"{scheme}://{ip or '<server-address>'}:{a.port}"
        print(f"\nArbDesk: open from anywhere — {where}  (or your domain / public IP)", flush=True)
        if tls:
            print("  Self-signed certificate: the browser warns once — Advanced → Proceed.", flush=True)
        if not auth.account():
            print(f"  Create your login and password with this one-time link (keep it private):\n"
                  f"  {where}/#setup={auth.new_setup_token()}\n", flush=True)
        else:
            print("  Sign in with your login and password. Forgot it: arbdesk reset-password\n", flush=True)
    elif not a.no_browser and sys.stdout.isatty() and not Path("/.dockerenv").exists() \
            and os.environ.get(update.HANDOFF_ENV) is None and not os.environ.get("ARBDESK_RESTARTED"):
        threading.Timer(1.5, webbrowser.open, (url,)).start()
        print(f"ArbDesk: {url}", flush=True)

    server = uvicorn.Server(uvicorn.Config("arbdesk.main:app", host=host, port=a.port, **tls))
    update.server = server
    server.run()
    if update.restart_requested:
        os.environ["ARBDESK_RESTARTED"] = "1"  # браузер второй раз не открываем
        update.exec_again(vault.handoff())


if __name__ == "__main__":
    main()
