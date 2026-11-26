import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
import { VENUE_LABEL, type VenueId } from "./types";

export type KeyRow = {
  id: string;
  venue: VenueId;
  demo: boolean;
  locked: boolean;
  usdt: number | null;
};

const VENUES = Object.keys(VENUE_LABEL) as VenueId[];
const PASSPHRASE: VenueId[] = ["okx", "kucoin", "bitget", "blofin"];

export function Keys({ onRows }: { onRows: (rows: KeyRow[]) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [venue, setVenue] = useState<VenueId>("bybit");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [password, setPassword] = useState("");
  const [vaultSecret, setVaultSecret] = useState("");
  const [demo, setDemo] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    void fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => setRows(d.rows || []));
  };

  useEffect(load, []);
  useEffect(() => onRows(rows), [rows, onRows]);

  const total = rows.reduce((sum, row) => sum + (row.usdt || 0), 0);
  const locked = rows.some((row) => row.locked);
  const needsPass = PASSPHRASE.includes(venue);

  const submit = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ venue, apiKey, apiSecret, password: needsPass ? password : "", vaultSecret, demo }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.detail || t("saveFail"));
      return;
    }
    setApiKey("");
    setApiSecret("");
    setPassword("");
    setRows(data.rows || []);
  };

  const unlock = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/keys/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultSecret }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.detail || t("secretFail"));
      return;
    }
    setRows(data.rows || []);
  };

  return (
    <div className="wallet" data-tour="keys">
      <button type="button" className={`chip ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M14.5 3a5.5 5.5 0 0 0-5.4 6.6L3 15.7V21h4.4l1.3-1.3v-2.4H11l1.6-1.6A5.5 5.5 0 1 0 14.5 3zm1.3 5.4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
        </svg>
        {rows.length === 0 ? t("key") : `${total.toFixed(2)} USDT`}
      </button>
      {open && (
        <div className="wallet-drop">
          {rows.map((row) => (
            <div className="wallet-row" key={row.id}>
              <img src={`/logos/${row.venue}.svg`} alt="" />
              <b>{VENUE_LABEL[row.venue]}</b>
              <span className="muted">{row.demo ? "demo" : "live"}</span>
              <strong>{row.locked ? t("hidden") : row.usdt == null ? "—" : `${row.usdt.toFixed(2)}`}</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void fetch(`/api/keys/${row.id}`, { method: "DELETE" }).then(load);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {locked && <p className="hint">{t("vaultHint")}</p>}
          <div className="ex-grid">
            {VENUES.map((id) => (
              <button
                key={id}
                type="button"
                className={venue === id ? "on" : ""}
                onClick={() => {
                  setVenue(id);
                  if (!PASSPHRASE.includes(id)) setPassword("");
                }}
              >
                <img src={`/logos/${id}.svg`} alt="" />
                <span>{VENUE_LABEL[id]}</span>
              </button>
            ))}
          </div>
          <label className="field">
            <span>api key</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <label className="field">
            <span>secret</span>
            <input type="password" autoComplete="off" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
          </label>
          {needsPass && (
            <label className="field">
              <span>passphrase</span>
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>{t("encSecret")}</span>
            <input type="password" autoComplete="off" value={vaultSecret} onChange={(e) => setVaultSecret(e.target.value)} />
          </label>
          <div className="mode">
            <button type="button" className={demo ? "on" : ""} onClick={() => setDemo(true)}>
              demo
            </button>
            <button type="button" className={demo ? "" : "on"} onClick={() => setDemo(false)}>
              live
            </button>
          </div>
          {error && <p className="neg">{error}</p>}
          <button type="button" className="save" disabled={busy} onClick={() => void submit()}>
            {t("save")}
          </button>
          <button type="button" className="ghost unlock" disabled={busy || !vaultSecret} onClick={() => void unlock()}>
            {t("unlock")}
          </button>
        </div>
      )}
    </div>
  );
}
