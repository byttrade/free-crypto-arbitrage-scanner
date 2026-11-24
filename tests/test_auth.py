"""Логин и пароль панели, публичный режим, одноразовая ссылка, защита от чужих сайтов."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from arbdesk import auth, settings


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(auth, "public", False)
    monkeypatch.setattr(auth, "setup_token", None)
    monkeypatch.setattr(auth, "_fails", {})
    monkeypatch.delenv("ALLOWED_HOSTS", raising=False)
    from arbdesk import main
    return main.app


def j(user="trader", password="correct-horse", **kw):
    return {"user": user, "password": password, "password2": password, **kw}


def test_password_cookie_expiry_and_reset(env):
    auth.save_account("trader", "correct-horse")
    assert "correct-horse" not in (settings.DATA_DIR / "auth.json").read_text()
    assert (settings.DATA_DIR / "auth.json").stat().st_mode & 0o777 == 0o600
    assert auth.check_password("trader", "correct-horse") and not auth.check_password("trader", "wrong-horse")
    c = auth.make_cookie(now=1000)
    assert auth.session_user(c, now=1001) == "trader"
    assert auth.session_user(c, now=1000 + auth.TTL + 1) is None              # истёк
    assert auth.session_user(c.replace("trader", "admin", 1), now=1001) is None  # подделка
    auth.save_account("trader", "another-pass")                              # сброс пароля
    assert auth.session_user(c, now=1001) is None                            # все входы сброшены
    with pytest.raises(ValueError):
        auth.save_account("trader", "short")


def test_login_throttle():
    auth._fails.clear()
    for _ in range(4):
        auth.failed("1.2.3.4", now=0)
    assert auth.throttled("1.2.3.4", now=0) == 0
    auth.failed("1.2.3.4", now=0)
    assert auth.throttled("1.2.3.4", now=0) == 60 and auth.throttled("5.6.7.8", now=0) == 0
    auth.succeeded("1.2.3.4")
    assert auth.throttled("1.2.3.4", now=0) == 0


def test_local_without_account_works_and_setup_then_login_required(env):
    c = TestClient(env, base_url="http://127.0.0.1:8780")
    assert c.get("/api/settings").status_code == 200                         # как раньше: локально без пароля
    remote = TestClient(env, base_url="http://203.0.113.7:8780")
    assert remote.get("/api/settings").status_code == 403
    assert remote.post("/api/auth/setup", json=j()).status_code == 403        # создать извне нельзя
    assert c.post("/api/auth/setup", json={**j(), "password2": "x"}).status_code == 400
    r = c.post("/api/auth/setup", json=j())
    assert r.status_code == 200 and auth.COOKIE in r.cookies
    assert c.get("/api/settings").status_code == 200                         # cookie уже выдана
    assert c.post("/api/auth/setup", json=j(user="evil")).status_code == 403  # второй раз нельзя
    anon = TestClient(env, base_url="http://127.0.0.1:8780")
    assert anon.get("/api/settings").status_code == 401                      # с учётной записью — только со входом
    assert anon.get("/").status_code in (200, 404) and anon.get("/api/auth/status").json()["account"] is True
    assert remote.post("/api/auth/login", json={"user": "trader", "password": "nope-nope"}).status_code == 401
    assert remote.post("/api/auth/login", json={"user": "trader", "password": "correct-horse"}).status_code == 200
    assert remote.get("/api/settings").status_code == 200                     # извне — после входа
    with pytest.raises(WebSocketDisconnect) as e:
        with anon.websocket_connect("ws://127.0.0.1:8780/ws") as s:
            s.receive_text()
    assert e.value.code == 4401
    assert remote.get("/api/settings", headers={"Origin": "https://evil.example"}).status_code == 403


def test_public_mode_needs_the_one_time_link(env, monkeypatch):
    monkeypatch.setattr(auth, "public", True)
    token = auth.new_setup_token()
    local = TestClient(env, base_url="http://127.0.0.1:8780")
    assert local.get("/api/settings").status_code == 403                      # Host подделывается — не доверяем
    st = local.get("/api/auth/status").json()
    assert st["needToken"] and not st["authed"]
    assert local.post("/api/auth/setup", json=j()).status_code == 403
    assert local.post("/api/auth/setup", json=j(token="wrong")).status_code == 403
    assert local.post("/api/auth/setup", json=j(token=token)).status_code == 200
    assert auth.setup_token is None                                           # ссылка одноразовая
    assert local.get("/api/settings").status_code == 200


def test_reset_password_command(env, monkeypatch):
    from arbdesk import __main__ as cli
    auth.save_account("trader", "correct-horse")
    answers = iter(["", ])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    pw = iter(["new-password-1", "typo", "new-password-1", "new-password-1"])
    monkeypatch.setattr(cli.getpass, "getpass", lambda _: next(pw))
    cli.reset_password()
    assert auth.check_password("trader", "new-password-1")
