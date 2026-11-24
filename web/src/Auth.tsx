import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "./i18n";

type Status = { account: boolean; user: string | null; authed: boolean; public: boolean; setup: boolean; needToken: boolean };

const SKIP = "arbdesk.skipSetup";
const TXT = {
  en: {
    setupTitle: "Create your login", setupLead: "Protect the panel with a password. You will use it to open ArbDesk from any device.",
    loginTitle: "Sign in", loginLead: "Enter your ArbDesk login and password.",
    user: "Login", password: "Password", password2: "Repeat password", create: "Create and open", signin: "Sign in",
    skip: "Skip — use without a password on this computer only",
    tokenMissing: "Open the one-time link printed by the server: run `arbdesk --public` (Docker: `docker compose logs terminal`).",
    localOnly: "This panel has no password yet, so it opens only on the computer it runs on. To open it from elsewhere, start it with `arbdesk --public`.",
    forgot: "Forgot the password? On the server run: arbdesk reset-password", mismatch: "Passwords do not match",
    short: "At least 8 characters", logout: "Sign out", protect: "Set a password",
    badLogin: "Login: 3–40 letters, digits or . _ @ -", wrong: "Wrong login or password",
    wait: "Too many attempts, wait {s} s", expired: "The link was already used or expired — take a new one from the server terminal",
  },
  ru: {
    setupTitle: "Создайте вход", setupLead: "Защитите панель паролем — с ним ArbDesk откроется с любого устройства.",
    loginTitle: "Вход", loginLead: "Введите логин и пароль ArbDesk.",
    user: "Логин", password: "Пароль", password2: "Повторите пароль", create: "Создать и открыть", signin: "Войти",
    skip: "Пропустить — без пароля, только на этом компьютере",
    tokenMissing: "Откройте одноразовую ссылку, которую напечатал сервер: `arbdesk --public` (Docker: `docker compose logs terminal`).",
    localOnly: "У панели ещё нет пароля, поэтому она открывается только на компьютере, где запущена. Чтобы открывать её извне, запустите `arbdesk --public`.",
    forgot: "Забыли пароль? На сервере выполните: arbdesk reset-password", mismatch: "Пароли не совпадают",
    short: "Не короче 8 символов", logout: "Выйти", protect: "Задать пароль",
    badLogin: "Логин: 3–40 символов — буквы, цифры, . _ @ -", wrong: "Неверный логин или пароль",
    wait: "Слишком много попыток, подождите {s} с", expired: "Ссылка уже использована или устарела — возьмите новую в терминале сервера",
  },
};

const Ctx = createContext<Status | null>(null);

const skipped = () => {
  try { return localStorage.getItem(SKIP) === "1"; } catch { return false; }
};

export function AuthGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<Status | null>(null);
  const [skip, setSkip] = useState(skipped);
  useEffect(() => {
    fetch("/api/auth/status").then((r) => r.json()).then(setSt).catch(() => setSt(null));
  }, []);
  if (!st) return null;
  const token = new URLSearchParams(location.hash.slice(1)).get("setup");
  let screen: ReactNode = null;
  if (st.account && !st.authed) screen = <Form mode="login" />;
  else if (!st.account && st.public) screen = token ? <Form mode="setup" token={token} /> : <Note k="tokenMissing" />;
  else if (!st.account && !st.authed) screen = <Note k="localOnly" />;
  else if (!st.account && st.setup && !skip) screen = <Form mode="setup" onSkip={() => {
    try { localStorage.setItem(SKIP, "1"); } catch { /* приватное окно */ }
    setSkip(true);
  }} />;
  return <Ctx.Provider value={st}>{screen ?? children}</Ctx.Provider>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="logo"><img src="/logos/byt.svg" alt="BYTtrade" /><span>Arb<b>Desk</b></span></div>
        {children}
      </div>
    </div>
  );
}

function Note({ k }: { k: "tokenMissing" | "localOnly" }) {
  const { lang } = useI18n();
  return <Shell><p className="auth-lead">{TXT[lang][k]}</p></Shell>;
}

function Form({ mode, token, onSkip }: { mode: "setup" | "login"; token?: string; onSkip?: () => void }) {
  const { lang } = useI18n();
  const L = TXT[lang];
  const [f, setF] = useState({ user: "", password: "", password2: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof f, label: string, type = "text", auto = "") => (
    <label className={`fl ${f[k] ? "has" : ""}`}>
      <input type={type} value={f[k]} autoComplete={auto} autoFocus={k === "user"} required
        onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      <span>{label}</span>
    </label>
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "setup" && f.password !== f.password2) return setErr(L.mismatch);
    if (mode === "setup" && f.password.length < 8) return setErr(L.short);
    if (mode === "setup" && !/^[\w.@-]{3,40}$/.test(f.user)) return setErr(L.badLogin);
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/auth/${mode}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, token }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      history.replaceState(null, "", location.pathname);  // одноразовую ссылку из адресной строки убираем
      return location.reload();
    }
    const detail = String((await r?.json().catch(() => null))?.detail || "error");
    setErr(r?.status === 401 ? L.wrong : r?.status === 429 ? L.wait.replace("{s}", detail.match(/\d+/)?.[0] || "60")
      : r?.status === 403 ? L.expired : detail);
  };
  return (
    <Shell>
      <h2>{mode === "setup" ? L.setupTitle : L.loginTitle}</h2>
      <p className="auth-lead">{mode === "setup" ? L.setupLead : L.loginLead}</p>
      <form className="dgrid auth-form" onSubmit={submit}>
        {field("user", L.user, "text", "username")}
        {field("password", L.password, "password", mode === "setup" ? "new-password" : "current-password")}
        {mode === "setup" && field("password2", L.password2, "password", "new-password")}
        {err && <p className="neg">{err}</p>}
        <button type="submit" className="save" disabled={busy}>{mode === "setup" ? L.create : L.signin}</button>
      </form>
      {onSkip && <button type="button" className="auth-skip" onClick={onSkip}>{L.skip}</button>}
      {mode === "login" && <p className="auth-hint">{L.forgot}</p>}
    </Shell>
  );
}

/** В подвале: «Выйти» при входе по паролю, «Задать пароль» — если пароль пропустили. */
export function Logout() {
  const st = useContext(Ctx);
  const { lang } = useI18n();
  if (!st) return null;
  if (st.account && st.user)
    return (
      <button type="button" className="upd-chip" onClick={() => fetch("/api/auth/logout", { method: "POST" }).then(() => location.reload())}>
        {st.user} · {TXT[lang].logout}
      </button>
    );
  if (!st.account && st.setup)
    return (
      <button type="button" className="upd-chip" onClick={() => {
        try { localStorage.removeItem(SKIP); } catch { /* приватное окно */ }
        location.reload();
      }}>{TXT[lang].protect}</button>
    );
  return null;
}
