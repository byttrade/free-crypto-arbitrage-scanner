import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useI18n } from "./i18n";

// Дневник трейдера: сделки из ручного ввода, CSV и связок терминала + отчёт с инфографикой.
// shortcut: суммы складываются без конвертации валют котировки (USDT/USDC/USD ≈ 1); для EUR/BTC-котировок нужен курс.

type Trade = {
  id: string; openedAt: number; closedAt: number | null; venue: string; base: string; quote: string;
  market: string; side: "long" | "short"; qty: number; entry: number; exit: number | null; fees: number;
  funding: number; pnl: number | null; leverage: number | null; strategy: string; tags: string[]; note: string;
  source: "manual" | "csv" | "terminal"; pnlValue: number | null; open: boolean;
};
type Group = { key: string; pnl: number; count: number; winRate?: number };
type Kpi = {
  pnl: number; trades: number; wins: number; losses: number; winRate: number; avgWin: number; avgLoss: number;
  profitFactor: number | null; expectancy: number; best: number; worst: number; maxDrawdown: number; fees: number;
  funding: number; longPnl: number; shortPnl: number; avgHoldH: number; winStreak: number; lossStreak: number;
  openCount: number; upnl: number;
};
type View = {
  trades: Trade[]; total: number;
  report: {
    kpi: Kpi; equity: [number, number][]; byDay: Record<string, number>; byMonth: Group[]; byStrategy: Group[];
    byVenue: Group[]; byCoin: Group[]; byMarket: Group[]; byWeekday: Group[];
  };
  options: { strategies: string[]; venues: string[]; coins: string[] };
};
type Period = "7d" | "30d" | "90d" | "ytd" | "1y" | "all";
type Flt = { period: Period; strategy: string; venue: string; market: string; base: string };

const STRATEGIES = ["spread", "funding", "pairs", "trend", "breakout", "scalp", "swing", "news", "dca", "other"];
const VENUES = ["binance", "bybit", "okx", "bitget", "kucoin", "gate", "mexc", "htx", "bingx", "hyperliquid", "blofin"];

const TXT = {
  en: {
    title: "Trading diary", sub: "Your trades from any exchange, PnL and reports",
    add: "Add trade", importCsv: "Import CSV", template: "CSV template", exportCsv: "Export CSV", print: "Report / PDF",
    p7d: "7d", p30d: "30d", p90d: "90d", pytd: "YTD", p1y: "1y", pall: "All",
    allStrategies: "all strategies", allVenues: "all exchanges", allMarkets: "all markets", allCoins: "all coins",
    netPnl: "Net PnL", winRate: "Win rate", pf: "Profit factor", trades: "Trades", maxDd: "Max drawdown",
    avgWL: "Avg win / loss", costs: "Fees · funding", openPos: "Open positions", expectancy: "Expectancy",
    best: "Best", worst: "Worst", streak: "Streaks", hold: "Avg hold", longShort: "Long vs short",
    equity: "Equity curve", calendar: "Daily PnL", monthly: "Monthly PnL", byStrategy: "By strategy",
    byVenue: "By exchange", byCoin: "Coins: best and worst", byWeekday: "By weekday", byMarket: "By market",
    wins: "wins", losses: "losses", perTrade: "per trade", hours: "h", days: "d",
    date: "closed", coin: "coin", market: "market", venue: "exchange", side: "side", qty: "qty", entry: "entry",
    exit: "exit", fees: "fees", pnl: "PnL", strategy: "strategy", note: "note", open: "open",
    emptyTitle: "Your trading diary is empty",
    emptyText: "Add trades by hand or import a CSV export from your exchange (closed PnL / trade history). Pairs closed in the terminal appear here automatically.",
    edit: "Edit", del: "Delete", delAsk: "Delete this trade?", save: "Save", cancel: "Cancel",
    openedAt: "Opened", closedAt: "Closed (empty = still open)", symbol: "Pair, e.g. BTC/USDT", long: "Long", short: "Short",
    pnlOverride: "PnL if known (overrides calculation)", leverage: "Leverage", tags: "Tags, comma separated", fundingL: "Funding",
    preview: "PnL", imported: "Imported {added}, skipped duplicates {skipped}", errors: "Errors",
    fromTerminal: "from terminal", fromCsv: "CSV", report: "Trading report", period: "Period", generated: "Generated",
    noData: "no closed trades in this period", shown: "showing {n} of {total}", wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    less: "loss", more: "profit", upnl: "unrealized",
  },
  ru: {
    title: "Дневник трейдера", sub: "Ваши сделки с любых бирж, PnL и отчёты",
    add: "Добавить сделку", importCsv: "Импорт CSV", template: "Шаблон CSV", exportCsv: "Экспорт CSV", print: "Отчёт / PDF",
    p7d: "7д", p30d: "30д", p90d: "90д", pytd: "С начала года", p1y: "Год", pall: "Всё",
    allStrategies: "все стратегии", allVenues: "все биржи", allMarkets: "все рынки", allCoins: "все монеты",
    netPnl: "Итоговый PnL", winRate: "Доля прибыльных", pf: "Профит-фактор", trades: "Сделок", maxDd: "Макс. просадка",
    avgWL: "Средняя прибыль / убыток", costs: "Комиссии · фандинг", openPos: "Открытые позиции", expectancy: "Матожидание",
    best: "Лучшая", worst: "Худшая", streak: "Серии", hold: "Среднее удержание", longShort: "Лонг и шорт",
    equity: "Кривая капитала", calendar: "PnL по дням", monthly: "PnL по месяцам", byStrategy: "По стратегиям",
    byVenue: "По биржам", byCoin: "Монеты: лучшие и худшие", byWeekday: "По дням недели", byMarket: "По рынкам",
    wins: "плюс", losses: "минус", perTrade: "на сделку", hours: "ч", days: "д",
    date: "закрыта", coin: "монета", market: "рынок", venue: "биржа", side: "сторона", qty: "объём", entry: "вход",
    exit: "выход", fees: "комиссии", pnl: "PnL", strategy: "стратегия", note: "заметка", open: "открыта",
    emptyTitle: "Дневник пока пуст",
    emptyText: "Добавьте сделки вручную или загрузите CSV-выгрузку с биржи (закрытый PnL / история сделок). Связки, закрытые в терминале, попадают сюда сами.",
    edit: "Изменить", del: "Удалить", delAsk: "Удалить сделку?", save: "Сохранить", cancel: "Отмена",
    openedAt: "Открыта", closedAt: "Закрыта (пусто — ещё открыта)", symbol: "Пара, например BTC/USDT", long: "Лонг", short: "Шорт",
    pnlOverride: "PnL, если известен (вместо расчёта)", leverage: "Плечо", tags: "Теги через запятую", fundingL: "Фандинг",
    preview: "PnL", imported: "Загружено {added}, пропущено повторов {skipped}", errors: "Ошибки",
    fromTerminal: "из терминала", fromCsv: "CSV", report: "Отчёт по торговле", period: "Период", generated: "Сформирован",
    noData: "нет закрытых сделок за период", shown: "показано {n} из {total}", wd: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    less: "убыток", more: "прибыль", upnl: "нереализ.",
  },
};
type L = typeof TXT.en;

const POS = "var(--bid)";
const NEG = "var(--ask)";

function num(n: number) {
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6, useGrouping: Math.abs(n) >= 1e5 });
}
function fmt(n: number | null | undefined, sign = true, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? "−" : sign && n > 0 ? "+" : ""}${s}`;
}
function short(n: number) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(0)}K` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(a >= 100 ? 0 : 1);
  return `${n < 0 ? "−" : ""}${s}`;
}
const cls = (n: number | null | undefined) => (n == null ? "muted" : n > 0 ? "pos" : n < 0 ? "neg" : "muted");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function localInput(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function periodFrom(p: Period): number | null {
  const now = Date.now();
  if (p === "all") return null;
  if (p === "ytd") return Date.UTC(new Date().getUTCFullYear(), 0, 1);
  const days = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[p];
  return now - days * 86_400_000;
}

/* ---------- инфографика (SVG без библиотек) ---------- */

function Card({ title, children, wide, className = "" }: { title: string; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <section className={`dcard ${wide ? "wide" : ""} ${className}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Equity({ points, empty }: { points: [number, number][]; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (points.length < 2) return <div className="dempty-chart">{empty}</div>;
  const W = 900, H = 260, P = 34;
  const pts: [number, number][] = [[points[0][0] - 1, 0], ...points];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const X = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - P - 8);
  const Y = (y: number) => 10 + (1 - (y - y0) / (y1 - y0 || 1)) * (H - 40);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  let peak = -Infinity;
  const dd = pts.map((p) => { peak = Math.max(peak, p[1]); return [p[0], peak] as [number, number]; });
  const ddArea = `${dd.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("")}${[...pts].reverse().map((p) => `L${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("")}Z`;
  const last = ys[ys.length - 1];
  const color = last >= 0 ? POS : NEG;
  const ticks = [y0, (y0 + y1) / 2, y1];
  const h = hover == null ? null : pts[hover];
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="dchart"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W;
        let best = 0;
        pts.forEach((p, i) => { if (Math.abs(X(p[0]) - x) < Math.abs(X(pts[best][0]) - x)) best = i; });
        setHover(best);
      }}
    >
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={P} x2={W - 8} y1={Y(v)} y2={Y(v)} className="grid" />
          <text x={P - 6} y={Y(v) + 4} textAnchor="end" className="axis">{short(v)}</text>
        </g>
      ))}
      <line x1={P} x2={W - 8} y1={Y(0)} y2={Y(0)} className="zero" />
      <path d={ddArea} fill={NEG} opacity=".13" />
      <path d={`${line}L${X(x1)},${Y(y0)}L${X(x0)},${Y(y0)}Z`} fill="url(#eqfill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" className="draw" />
      <text x={P} y={H - 6} className="axis">{day(x0 + 1)}</text>
      <text x={W - 8} y={H - 6} textAnchor="end" className="axis">{day(x1)}</text>
      {h && (
        <g>
          <line x1={X(h[0])} x2={X(h[0])} y1={8} y2={H - 28} className="cross" />
          <circle cx={X(h[0])} cy={Y(h[1])} r="5" fill={color} stroke="#07090c" strokeWidth="2" />
          <g transform={`translate(${Math.min(X(h[0]) + 10, W - 150)} 14)`}>
            <rect width="140" height="40" rx="7" className="tip" />
            <text x="10" y="17" className="axis">{day(h[0])}</text>
            <text x="10" y="33" className={`tipv ${cls(h[1])}`}>{fmt(h[1])}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

function Calendar({ byDay, L, lang }: { byDay: Record<string, number>; L: L; lang: string }) {
  const weeks = 26;
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const endDow = (new Date(end).getUTCDay() + 6) % 7;
  const start = end - (weeks * 7 - 1 - (6 - endDow)) * 86_400_000;
  const vals = Object.values(byDay);
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  const cells = [];
  const months: { x: number; label: string }[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const ms = start + i * 86_400_000;
    if (ms > end) break;
    const w = Math.floor(i / 7), d = i % 7;
    const key = day(ms);
    const v = byDay[key];
    const a = v == null ? 0 : 0.25 + 0.75 * Math.min(1, Math.abs(v) / max);
    if (key.endsWith("-01") || i === 0) months.push({ x: w, label: new Date(ms).toLocaleString(lang, { month: "short", timeZone: "UTC" }) });
    cells.push(
      <rect key={key} x={26 + w * 15} y={16 + d * 15} width="12" height="12" rx="3"
        fill={v == null ? "#1a212b" : v >= 0 ? POS : NEG} fillOpacity={v == null ? 1 : a}>
        <title>{`${key}: ${v == null ? "—" : fmt(v)}`}</title>
      </rect>,
    );
  }
  return (
    <svg viewBox={`0 0 ${30 + weeks * 15} 142`} className="dchart cal">
      {months.map((m, i) => <text key={i} x={26 + m.x * 15} y="10" className="axis">{m.label}</text>)}
      {[0, 2, 4].map((d) => <text key={d} x="0" y={26 + d * 15} className="axis">{L.wd[d]}</text>)}
      {cells}
      <g transform="translate(90 138)">
        <text x="-6" y="0" textAnchor="end" className="axis">{L.less}</text>
        {[1, 0.6, 0.3].map((o, i) => <rect key={`n${i}`} x={i * 12} y="-9" width="10" height="10" rx="2" fill={NEG} fillOpacity={o} />)}
        <rect x="38" y="-9" width="10" height="10" rx="2" fill="#1a212b" />
        {[0.3, 0.6, 1].map((o, i) => <rect key={`p${i}`} x={50 + i * 12} y="-9" width="10" height="10" rx="2" fill={POS} fillOpacity={o} />)}
        <text x="92" y="0" className="axis">{L.more}</text>
      </g>
    </svg>
  );
}

function Columns({ rows, label, width = 440 }: { rows: Group[]; label?: (k: string) => string; width?: number }) {
  if (!rows.length) return <div className="dempty-chart">—</div>;
  const W = width, H = 190, base = 150;
  const top = 18;
  const hi = Math.max(0, ...rows.map((r) => r.pnl)), lo = Math.min(0, ...rows.map((r) => r.pnl));
  const scale = (base - top) / (hi - lo || 1);
  const zero = top + hi * scale;
  const bw = Math.min(46, (W - 20) / rows.length - 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dchart">
      <line x1="6" x2={W - 6} y1={zero} y2={zero} className="zero" />
      {rows.map((r, i) => {
        const x = 10 + i * ((W - 20) / rows.length) + ((W - 20) / rows.length - bw) / 2;
        const h = Math.max(2, Math.abs(r.pnl) * scale);
        const y = r.pnl >= 0 ? zero - h : zero;
        return (
          <g key={r.key} className="bar" style={{ animationDelay: `${i * 40}ms` }}>
            <rect x={x} y={y} width={bw} height={h} rx="4" fill={r.pnl >= 0 ? POS : NEG}>
              <title>{`${r.key}: ${fmt(r.pnl)} · ${r.count}`}</title>
            </rect>
            {rows.length <= 14 && <text x={x + bw / 2} y={r.pnl >= 0 ? y - 4 : y + h + 12} textAnchor="middle" className="axis">{short(r.pnl)}</text>}
            <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis">{label ? label(r.key) : r.key}</text>
          </g>
        );
      })}
    </svg>
  );
}

function HBars({ rows, limit = 8 }: { rows: Group[]; limit?: number }) {
  if (!rows.length) return <div className="dempty-chart">—</div>;
  const list = rows.length > limit ? [...rows.slice(0, Math.ceil(limit / 2)), ...rows.slice(-Math.floor(limit / 2))] : rows;
  const max = Math.max(1e-9, ...list.map((r) => Math.abs(r.pnl)));
  return (
    <div className="hbars">
      {list.map((r) => (
        <div key={r.key} className="hbar" title={`${r.count} · win ${Math.round(r.winRate ?? 0)}%`}>
          <span className="k">{r.key}</span>
          <span className="track">
            <span className="half neg">{r.pnl < 0 && <i style={{ width: `${(Math.abs(r.pnl) / max) * 100}%` }} />}</span>
            <span className="half pos">{r.pnl > 0 && <i style={{ width: `${(r.pnl / max) * 100}%` }} />}</span>
          </span>
          <span className={`v ${cls(r.pnl)}`}>{fmt(r.pnl)}</span>
          <span className="n muted">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

function Ring({ pct, label }: { pct: number; label: string }) {
  const r = 30, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 80 80" className="ring">
      <circle cx="40" cy="40" r={r} className="ring-bg" />
      <circle cx="40" cy="40" r={r} className="ring-fg" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 40 40)" />
      <text x="40" y="44" textAnchor="middle" className="ring-t">{label}</text>
    </svg>
  );
}

function Spark({ points }: { points: [number, number][] }) {
  if (points.length < 2) return null;
  const ys = [0, ...points.map((p) => p[1])];
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const d = ys.map((y, i) => `${i ? "L" : "M"}${(i / (ys.length - 1)) * 160},${36 - ((y - y0) / (y1 - y0 || 1)) * 32}`).join("");
  return <svg viewBox="0 0 160 40" className="spark"><path d={d} fill="none" stroke={ys[ys.length - 1] >= 0 ? POS : NEG} strokeWidth="2" /></svg>;
}

function Split({ a, b, la, lb }: { a: number; b: number; la: string; lb: string }) {
  const tot = Math.abs(a) + Math.abs(b) || 1;
  return (
    <div className="split">
      <div className="split-bar">
        <i className={a >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(a) / tot) * 100}%` }} />
        <i className={b >= 0 ? "pos alt" : "neg alt"} style={{ width: `${(Math.abs(b) / tot) * 100}%` }} />
      </div>
      <div className="split-l"><span>{la} <b className={cls(a)}>{fmt(a)}</b></span><span>{lb} <b className={cls(b)}>{fmt(b)}</b></span></div>
    </div>
  );
}

/* ---------- форма сделки ---------- */

const EMPTY = {
  id: "", openedAt: "", closedAt: "", venue: "", symbol: "", market: "perp", side: "long" as "long" | "short",
  qty: "", entry: "", exit: "", fees: "", funding: "", pnl: "", leverage: "", strategy: "", tags: "", note: "",
};
type Form = typeof EMPTY;

function toForm(t: Trade): Form {
  return {
    id: t.id, openedAt: localInput(t.openedAt), closedAt: localInput(t.closedAt), venue: t.venue, symbol: `${t.base}/${t.quote}`,
    market: t.market, side: t.side, qty: String(t.qty), entry: String(t.entry), exit: t.exit == null ? "" : String(t.exit),
    fees: t.fees ? String(t.fees) : "", funding: t.funding ? String(t.funding) : "", pnl: t.pnl == null ? "" : String(t.pnl),
    leverage: t.leverage == null ? "" : String(t.leverage), strategy: t.strategy, tags: t.tags.join(", "), note: t.note,
  };
}

function TradeForm({ init, L, onClose, onSaved }: { init: Form; L: L; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(init);
  const [err, setErr] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  // подпись живёт внутри поля: пустое поле — как плейсхолдер, при вводе уезжает вверх
  const fld = (k: keyof Form, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}, extra = "") => (
    <label className={`fl ${extra} ${f[k] ? "has" : ""}`}>
      <input {...props} value={f[k]} onChange={set(k)} />
      <span>{label}</span>
    </label>
  );
  const num = (s: string) => Number(s.replace(",", "."));
  const calc = (() => {
    if (f.pnl.trim()) return num(f.pnl);
    if (!f.exit || !f.qty || !f.entry) return null;
    const d = f.side === "long" ? 1 : -1;
    return d * (num(f.exit) - num(f.entry)) * num(f.qty) - (num(f.fees || "0") || 0) + (num(f.funding || "0") || 0);
  })();
  const submit = async () => {
    setErr("");
    const toMs = (s: string) => (s ? new Date(s).getTime() : null);
    const body = {
      ...f, openedAt: toMs(f.openedAt), closedAt: toMs(f.closedAt), id: f.id || undefined,
      tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean),
    };
    const r = await fetch("/api/diary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      setErr((await r.json().catch(() => ({}))).detail || "error");
      return;
    }
    onSaved();
  };
  return (
    <div className="dmodal" role="dialog" aria-modal onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dsheet">
        <header>
          <h3>{f.id ? L.edit : L.add}</h3>
          <div className="seg">
            {(["long", "short"] as const).map((s) => (
              <button key={s} type="button" className={`${f.side === s ? "on" : ""} ${s}`} onClick={() => setF({ ...f, side: s })}>{L[s]}</button>
            ))}
          </div>
        </header>
        <div className="dgrid">
          {fld("symbol", L.symbol, { autoFocus: true })}
          {fld("venue", L.venue, { list: "d-venues" })}
          <label className="fl has">
            <select value={f.market} onChange={set("market")}>
              {["spot", "perp", "margin", "option", "other"].map((m) => <option key={m}>{m}</option>)}
            </select>
            <span>{L.market}</span>
          </label>
          {fld("strategy", L.strategy, { list: "d-strategies" })}
          {fld("openedAt", L.openedAt, { type: "datetime-local" })}
          {fld("closedAt", L.closedAt, { type: "datetime-local" })}
          {fld("qty", L.qty, { inputMode: "decimal" })}
          {fld("leverage", L.leverage, { inputMode: "decimal" })}
          {fld("entry", L.entry, { inputMode: "decimal" })}
          {fld("exit", L.exit, { inputMode: "decimal" })}
          {fld("fees", L.fees, { inputMode: "decimal" })}
          {fld("funding", L.fundingL, { inputMode: "decimal" })}
          {fld("pnl", L.pnlOverride, { inputMode: "decimal" }, "span2")}
          {fld("tags", L.tags, {}, "span2")}
          <label className={`fl span2 area ${f.note ? "has" : ""}`}>
            <textarea rows={3} value={f.note} onChange={set("note")} />
            <span>{L.note}</span>
          </label>
        </div>
        <datalist id="d-venues">{VENUES.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="d-strategies">{STRATEGIES.map((v) => <option key={v} value={v} />)}</datalist>
        <footer>
          <span className="dpreview">{L.preview} <b className={cls(calc)}>{fmt(calc)}</b></span>
          {err && <span className="neg">{err}</span>}
          <button type="button" className="ghost" onClick={onClose}>{L.cancel}</button>
          <button type="button" className="save" onClick={submit}>{L.save}</button>
        </footer>
      </div>
    </div>
  );
}

/* ---------- страница ---------- */

export function Diary() {
  const { lang } = useI18n();
  const L = TXT[lang];
  const [flt, setFlt] = useState<Flt>({ period: "all", strategy: "", venue: "", market: "", base: "" });
  const [data, setData] = useState<View | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ text: string; errors: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useMemo(() => {
    const q = new URLSearchParams();
    const from = periodFrom(flt.period);
    if (from) q.set("from", String(from));
    for (const k of ["strategy", "venue", "market", "base"] as const) if (flt[k]) q.set(k, flt[k]);
    return q.toString();
  }, [flt]);

  const load = useCallback(() => {
    void fetch(`/api/diary?${query}`).then((r) => r.json()).then(setData).catch(() => undefined);
  }, [query]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 15_000);  // нереализованный PnL открытых сделок
    return () => window.clearInterval(id);
  }, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const r = await fetch("/api/diary/import", { method: "POST", body: await file.text() }).then((x) => x.json());
    setMsg({ text: L.imported.replace("{added}", String(r.added ?? 0)).replace("{skipped}", String(r.skipped ?? 0)), errors: r.errors || [] });
    if (fileRef.current) fileRef.current.value = "";
    load();
  };
  const template = () => {
    const csv = "openedAt,closedAt,venue,base,quote,market,side,qty,entry,exit,fees,funding,pnl,leverage,strategy,tags,note\n"
      + "2026-11-03 09:30:00,2026-11-04 15:10:00,bybit,BTC,USDT,perp,long,0.05,90250,92100,4.6,-0.8,,3,trend,breakout,example\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "arbdesk-trades-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const remove = async (t: Trade) => {
    if (!window.confirm(`${L.delAsk}\n${t.base} ${t.side} ${t.qty}`)) return;
    await fetch(`/api/diary/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    load();
  };

  const k = data?.report.kpi;
  const opts = data?.options;
  const empty = data && data.total === 0 && !flt.strategy && !flt.venue && !flt.market && !flt.base && flt.period === "all";
  const periodLabel = L[`p${flt.period}` as "p7d"];

  return (
    <div className="diary">
      <div className="dhead">
        <div>
          <h2>{L.title}</h2>
          <p className="muted">{L.sub}</p>
        </div>
        <div className="dactions">
          <button type="button" className="save" onClick={() => setForm({ ...EMPTY, openedAt: localInput(Date.now()) })}>＋ {L.add}</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>⇪ {L.importCsv}</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
          <button type="button" className="ghost" onClick={template}>{L.template}</button>
          <a className="ghost btn" href={`/api/diary/export.csv?${query}`}>⇩ {L.exportCsv}</a>
          <button type="button" className="ghost" onClick={() => window.print()}>⎙ {L.print}</button>
        </div>
      </div>

      <div className="print-only dprint-head">
        <b>ArbDesk · {L.report}</b>
        <span>{L.period}: {periodLabel}{flt.strategy ? ` · ${flt.strategy}` : ""}{flt.venue ? ` · ${flt.venue}` : ""}{flt.base ? ` · ${flt.base}` : ""}</span>
        <span>{L.generated}: {new Date().toLocaleString()}</span>
      </div>

      {msg && (
        <div className="dmsg" onClick={() => setMsg(null)}>
          <b>{msg.text}</b>
          {msg.errors.length > 0 && <details><summary>{L.errors}: {msg.errors.length}</summary>{msg.errors.map((e) => <div key={e}>{e}</div>)}</details>}
        </div>
      )}

      {empty ? (
        <div className="dempty">
          <svg viewBox="0 0 120 80" className="dempty-art" aria-hidden>
            <rect x="6" y="10" width="108" height="62" rx="10" className="ea-box" />
            <path d="M18 58 L38 44 L54 50 L74 28 L90 36 L104 20" className="ea-line" />
            <circle cx="104" cy="20" r="4" className="ea-dot" />
          </svg>
          <h3>{L.emptyTitle}</h3>
          <p className="muted">{L.emptyText}</p>
          <div className="dactions">
            <button type="button" className="save" onClick={() => setForm({ ...EMPTY, openedAt: localInput(Date.now()) })}>＋ {L.add}</button>
            <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>⇪ {L.importCsv}</button>
            <button type="button" className="ghost" onClick={template}>{L.template}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="dfilters">
            <div className="seg">
              {(["7d", "30d", "90d", "ytd", "1y", "all"] as Period[]).map((p) => (
                <button key={p} type="button" className={flt.period === p ? "on" : ""} onClick={() => setFlt({ ...flt, period: p })}>{L[`p${p}` as "p7d"]}</button>
              ))}
            </div>
            <select value={flt.strategy} onChange={(e) => setFlt({ ...flt, strategy: e.target.value })}>
              <option value="">{L.allStrategies}</option>
              {opts?.strategies.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={flt.venue} onChange={(e) => setFlt({ ...flt, venue: e.target.value })}>
              <option value="">{L.allVenues}</option>
              {opts?.venues.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={flt.market} onChange={(e) => setFlt({ ...flt, market: e.target.value })}>
              <option value="">{L.allMarkets}</option>
              {["spot", "perp", "margin", "option", "other"].map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={flt.base} onChange={(e) => setFlt({ ...flt, base: e.target.value })}>
              <option value="">{L.allCoins}</option>
              {opts?.coins.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>

          {k && (
            <div className="kpis">
              <div className="kpi hero">
                <span className="kl">{L.netPnl}</span>
                <span className={`kv big ${cls(k.pnl)}`}>{fmt(k.pnl)}</span>
                <Spark points={data!.report.equity} />
                <span className="ks muted">{L.expectancy} {fmt(k.expectancy)} {L.perTrade}</span>
              </div>
              <div className="kpi ring-k">
                <Ring pct={k.winRate} label={`${Math.round(k.winRate)}%`} />
                <div>
                  <span className="kl">{L.winRate}</span>
                  <span className="ks"><b className="pos">{k.wins}</b> {L.wins} · <b className="neg">{k.losses}</b> {L.losses}</span>
                </div>
              </div>
              <div className="kpi">
                <span className="kl">{L.pf}</span>
                <span className={`kv ${k.profitFactor == null || k.profitFactor >= 1 ? "pos" : "neg"}`}>{k.profitFactor == null ? (k.wins ? "∞" : "—") : k.profitFactor.toFixed(2)}</span>
                <span className="ks muted">{L.trades}: {k.trades}</span>
              </div>
              <div className="kpi">
                <span className="kl">{L.maxDd}</span>
                <span className="kv neg">{k.maxDrawdown ? fmt(-k.maxDrawdown) : "0.00"}</span>
                <span className="ks muted">{L.streak}: <b className="pos">{k.winStreak}</b> / <b className="neg">{k.lossStreak}</b></span>
              </div>
              <div className="kpi">
                <span className="kl">{L.avgWL}</span>
                <span className="kv mid"><b className="pos">{fmt(k.avgWin)}</b> <span className="muted">/</span> <b className="neg">{fmt(k.avgLoss)}</b></span>
                <span className="ks muted">{L.best} {fmt(k.best)} · {L.worst} {fmt(k.worst)}</span>
              </div>
              <div className="kpi">
                <span className="kl">{L.costs}</span>
                <span className="kv neg">{fmt(-k.fees)}</span>
                <span className="ks muted">funding <b className={cls(k.funding)}>{fmt(k.funding)}</b> · {L.hold} {k.avgHoldH >= 48 ? `${(k.avgHoldH / 24).toFixed(1)}${L.days}` : `${k.avgHoldH.toFixed(1)}${L.hours}`}</span>
              </div>
              {k.openCount > 0 && (
                <div className="kpi">
                  <span className="kl">{L.openPos}</span>
                  <span className={`kv ${cls(k.upnl)}`}>{fmt(k.upnl)}</span>
                  <span className="ks muted">{k.openCount} · {L.upnl}</span>
                </div>
              )}
            </div>
          )}

          {data && (
            <div className="dcharts">
              <Card title={L.equity} wide><Equity points={data.report.equity} empty={L.noData} /></Card>
              <Card title={L.calendar} className="s2"><Calendar byDay={data.report.byDay} L={L} lang={lang} /></Card>
              <Card title={L.monthly} className="s2"><Columns rows={data.report.byMonth.slice(-12)} label={(m) => new Date(`${m}-01T00:00:00Z`).toLocaleString(lang, { month: "short", timeZone: "UTC" })} /></Card>
              <Card title={L.byStrategy} className="s2"><HBars rows={data.report.byStrategy} /></Card>
              <Card title={L.byVenue} className="s2"><HBars rows={data.report.byVenue} /></Card>
              <Card title={L.byCoin} className="s2"><HBars rows={data.report.byCoin} limit={10} /></Card>
              <Card title={L.byWeekday}>
                <Columns rows={[0, 1, 2, 3, 4, 5, 6].map((d) => data.report.byWeekday.find((g) => g.key === String(d)) || { key: String(d), pnl: 0, count: 0 })} label={(d) => L.wd[Number(d)]} width={300} />
              </Card>
              <Card title={`${L.longShort} · ${L.byMarket}`}>
                <Split a={k?.longPnl ?? 0} b={k?.shortPnl ?? 0} la={L.long} lb={L.short} />
                <HBars rows={data.report.byMarket} />
              </Card>
            </div>
          )}

          {data && (
            <div className="dtable">
              <table>
                <thead>
                  <tr>
                    <th>{L.date}</th><th>{L.coin}</th><th>{L.venue}</th><th>{L.side}</th><th className="r">{L.qty}</th>
                    <th className="r">{L.entry}</th><th className="r">{L.exit}</th><th className="r">{L.fees}</th>
                    <th className="r">{L.pnl}</th><th>{L.strategy}</th><th>{L.note}</th><th className="noprint" />
                  </tr>
                </thead>
                <tbody>
                  {data.trades.map((t) => (
                    <tr key={t.id}>
                      <td className="muted">{new Date(t.closedAt ?? t.openedAt).toLocaleString(lang, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</td>
                      <td><b>{t.base}</b><span className="muted">/{t.quote} {t.market}</span></td>
                      <td>{t.venue || "—"}</td>
                      <td><span className={`dside ${t.side}`}>{t.side === "long" ? L.long : L.short}</span>{t.leverage ? <span className="muted"> {t.leverage}x</span> : null}</td>
                      <td className="r">{num(t.qty)}</td>
                      <td className="r">{t.entry ? num(t.entry) : "—"}</td>
                      <td className="r">{t.open ? <span className="dopen">{L.open}</span> : t.exit == null ? "—" : num(t.exit)}</td>
                      <td className="r muted">{t.fees ? fmt(t.fees, false) : "—"}</td>
                      <td className={`r ${cls(t.pnlValue)}`}><b>{fmt(t.pnlValue)}</b>{t.open && t.pnlValue != null && <div className="muted small">{L.upnl}</div>}</td>
                      <td>{t.strategy && <span className="dtag">{t.strategy}</span>}{t.tags.map((g) => <span key={g} className="dtag alt">{g}</span>)}{t.source !== "manual" && <span className="dsrc">{t.source === "terminal" ? L.fromTerminal : L.fromCsv}</span>}</td>
                      <td className="dnote" title={t.note}>{t.note}</td>
                      <td className="noprint acts">
                        {t.source !== "terminal" && (
                          <>
                            <button type="button" className="mini" onClick={() => setForm(toForm(t))}>{L.edit}</button>
                            <button type="button" className="mini sell" onClick={() => void remove(t)}>×</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.total > data.trades.length && <p className="muted">{L.shown.replace("{n}", String(data.trades.length)).replace("{total}", String(data.total))}</p>}
            </div>
          )}
        </>
      )}

      {form && <TradeForm init={form} L={L} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}
