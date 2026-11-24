import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";

type Pkg = { name: string; current: string | null; available: string | null; incompatible: string | null; auto: boolean };
type St = {
  version: string; mode: "on" | "notify" | "off"; canRestart: boolean; updating: boolean; checkedAt: number;
  packages: Pkg[]; last: { event: string; package?: string; version?: string; error?: string; reason?: string } | null;
  blocked: Record<string, string>; wait: string | null;
};

const TXT = {
  en: {
    title: "Updates", mode: "Auto-update", on: "On", notify: "Notify", off: "Off", now: "Check & update now",
    hint: "bytx and ArbDesk update themselves in a quiet minute: no order in flight and none in the last 2 min. Positions and orders stay on the exchanges, keys stay unlocked.",
    manual: "Started without `arbdesk` / Docker: updates are only reported.", updating: "updating…",
    avail: "update", blocked: "orders blocked", checked: "checked", never: "not yet", wait: "waiting",
    upToDate: "up to date", newer: "new major",
  },
  ru: {
    title: "Обновления", mode: "Автообновление", on: "Вкл", notify: "Сообщать", off: "Выкл", now: "Проверить и обновить",
    hint: "bytx и ArbDesk обновляются сами в тихую минуту: нет ордера в полёте и не было ордеров 2 минуты. Позиции и ордера остаются на биржах, ключи остаются открытыми.",
    manual: "Запущено не через `arbdesk` / Docker: обновления только показываются.", updating: "обновление…",
    avail: "обновление", blocked: "ордера заблокированы", checked: "проверено", never: "ещё нет", wait: "ждём",
    upToDate: "актуально", newer: "новая major",
  },
};

export function Updates() {
  const { lang } = useI18n();
  const L = TXT[lang];
  const [st, setSt] = useState<St | null>(null);
  const [open, setOpen] = useState(false);
  const first = useRef<string | null>(null);

  const load = () =>
    fetch("/api/update").then((r) => r.json()).then((s: St) => {
      setSt(s);
      first.current ??= s.version;
      // панель обновилась: подтягиваем новый интерфейс, если пользователь ничего не заполняет
      if (first.current !== s.version && !document.querySelector(".dmodal, .modal, [role=dialog]")) location.reload();
    }).catch(() => undefined);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!st) return null;
  const post = (body: object) =>
    fetch("/api/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then(setSt);
  const blocked = Object.entries(st.blocked || {});
  const avail = st.packages.some((p) => p.available);
  const bytx = st.packages.find((p) => p.name === "bytx")?.current;
  const state = st.updating ? L.updating : blocked.length ? L.blocked : avail ? L.avail : "";

  return (
    <span className="upd">
      <button type="button" className={`upd-chip ${blocked.length ? "bad" : avail || st.updating ? "new" : ""}`} onClick={() => setOpen(!open)}>
        ArbDesk {st.version} · bytx {bytx || "—"}{state && <b> · {state}</b>}
      </button>
      {open && (
        <div className="upd-pop" role="dialog">
          <header><b>{L.title}</b><button type="button" className="x" onClick={() => setOpen(false)}>×</button></header>
          {blocked.map(([venue, why]) => <p key={venue} className="neg">{venue}: {why}</p>)}
          <table>
            <tbody>
              {st.packages.map((p) => (
                <tr key={p.name}>
                  <td>{p.name === "bytx" ? "bytx" : "ArbDesk"}</td>
                  <td className="r">{p.current || "—"}</td>
                  <td className={p.available ? "pos" : "muted"}>
                    {p.available ? `→ ${p.available}` : L.upToDate}
                    {p.incompatible && <span className="muted"> · {L.newer} {p.incompatible}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="upd-row">
            <span>{L.mode}</span>
            <span className="seg">
              {(["on", "notify", "off"] as const).map((m) => (
                <button key={m} type="button" className={st.mode === m ? "on" : ""} onClick={() => post({ mode: m })}>{L[m]}</button>
              ))}
            </span>
          </div>
          <p className="muted">{st.canRestart ? L.hint : L.manual}</p>
          <p className="muted">
            {L.checked}: {st.checkedAt ? new Date(st.checkedAt * 1000).toLocaleString(lang) : L.never}
            {st.wait && avail ? ` · ${L.wait}: ${st.wait}` : ""}
            {st.last ? ` · ${st.last.event}${st.last.package ? ` ${st.last.package} ${st.last.version || ""}` : ""}${st.last.error ? `: ${st.last.error}` : ""}` : ""}
          </p>
          <button type="button" className="save" disabled={st.updating || st.mode === "off"} onClick={() => post({ now: true })}>{L.now}</button>
        </div>
      )}
    </span>
  );
}
