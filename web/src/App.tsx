import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { MiniCharts, SpreadChart } from "./Chart";
import { Book, Tape, Venue, price, type LegPick } from "./Dom";
import { livePnl } from "./ladder";
import { srvText, useI18n } from "./i18n";
import { Diary } from "./Diary";
import { Updates } from "./Updates";
import { Logout } from "./Auth";
import { Keys, type KeyRow } from "./Keys";
import { Tabs } from "./Tabs";
import { Scalp, type ChartTarget } from "./Scalp";
import type {
  AlertEvent,
  CrossSpread,
  FundingRow,
  MarketKind,
  OrderBook,
  PairRow,
  Settings,
  TapeTrade,
  VenueId,
} from "./types";
import { VENUE_LABEL, type LiveOrder, type LivePos } from "./types";

type Tab = "cross" | "pairs" | "funding" | "chart" | "alerts" | "journal" | "diary";

type JLeg = { role: "buy" | "sell"; venue: VenueId; symbol: string; side: string; filled: number; avg: number | null; error: string | null; demo: boolean; keyId: string; exit?: { outside?: boolean } | null };
type JRow = {
  id: string; ts: number; kind: MarketKind; base: string; quote: string; notional: number; status: string;
  legs: JLeg[]; qtyBuy: number; qtySell: number; imbalance: number; entrySpreadPct: number | null; pnl: number | null; fees: number; tolPct: number; outside?: boolean;
};

type CoinRow = { venue: VenueId; symbol: string; bid: number; ask: number; volumeUsd: number; ageSec: number; ws: boolean; taker: number; odd?: boolean };

// Связка из любых двух бирж монеты: даже если спред отрицательный и её нет в таблице.
function legSpread(base: string, quote: string, kind: MarketKind, buy: CoinRow, sell: CoinRow, slip: number): CrossSpread {
  const spreadPct = ((sell.bid - buy.ask) / buy.ask) * 100;
  const fee = (buy.taker + sell.taker) * 2 * 100 + slip;
  return {
    id: `${kind}:${base}/${quote}:${buy.venue}->${sell.venue}`,
    base, quote, kind,
    buyVenue: buy.venue, sellVenue: sell.venue, buySymbol: buy.symbol, sellSymbol: sell.symbol,
    buyAsk: buy.ask, sellBid: sell.bid, spreadPct, netPct: spreadPct - fee, feesPct: fee - slip,
    volumeUsd: Math.min(buy.volumeUsd, sell.volumeUsd), ts: Date.now(),
  };
}

type Filters = {
  venues: VenueId[];
  kind: "" | MarketKind;
  quote: "" | "USDT" | "USDC";
  minSpread: number;
  minVol: number;
  netPos: boolean;
  hideBlocked: boolean;
  maxAgeMin: number;
  fundMin: number;
  fundPeriod: number;
  fundSign: "" | "+" | "-";
  pairCorr: number;
  pairZ: number;
  alertKind: "" | AlertEvent["kind"];
  watchOnly: boolean;
};

const NO_FILTERS: Filters = {
  venues: [], kind: "", quote: "", minSpread: 0, minVol: 0, netPos: false, hideBlocked: true, maxAgeMin: 0,
  fundMin: 0, fundPeriod: 0, fundSign: "", pairCorr: 0, pairZ: 0, alertKind: "", watchOnly: false,
};
const FILTER_KEY = "arb.filters";

function loadFilters(): Filters {
  try {
    return { ...NO_FILTERS, ...JSON.parse(localStorage.getItem(FILTER_KEY) || "{}") };
  } catch {
    return NO_FILTERS;
  }
}

function Seg<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <span className="flt-group">
      <em>{label}</em>
      <span className="flt-seg">
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" className={v === value ? "on" : ""} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </span>
    </span>
  );
}

function Pick({ label, value, options, onChange }: {
  label: string;
  value: number;
  options: [number, string][];
  onChange: (v: number) => void;
}) {
  return (
    <label className="flt-group">
      <em>{label}</em>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>{text}</option>
        ))}
      </select>
    </label>
  );
}

const VOL_OPTS: [number, string][] = [[0, "—"], [1e6, "1M"], [5e6, "5M"], [2e7, "20M"], [1e8, "100M"]];

type FilterPatch = Partial<Filters> | ((f: Filters) => Partial<Filters>);

type VenueHealth = { venue: string; kind: MarketKind; error: string | null; ageSec: number | null; count: number };
type VenueStat = { state: "ok" | "slow" | "down"; text: string };

function venueStats(rows: VenueHealth[]): Record<string, VenueStat> {
  const out: Record<string, VenueStat> = {};
  for (const v of new Set(rows.map((r) => r.venue))) {
    const mine = rows.filter((r) => r.venue === v);
    const best = Math.min(...mine.map((r) => r.ageSec ?? Infinity));
    out[v] = {
      state: best <= 15 ? "ok" : best <= 60 ? "slow" : "down",
      text: mine.map((r) => `${r.kind}: ${r.ageSec == null ? "—" : `${r.ageSec}s`} · ${r.count}${r.error ? ` · ${r.error}` : ""}`).join("\n"),
    };
  }
  return out;
}

function FilterBar({ tab, f, set, vstat }: { tab: Tab; f: Filters; set: (patch: FilterPatch) => void; vstat: Record<string, VenueStat> }) {
  const { t } = useI18n();
  if (tab === "journal" || tab === "diary") return null;
  const any = t("fltAny");
  const all = t("fltAll");
  const venues = Object.keys(VENUE_LABEL) as VenueId[];
  const toggle = (v: VenueId) => set((cur) => ({ venues: cur.venues.includes(v) ? cur.venues.filter((x) => x !== v) : [...cur.venues, v] }));
  const dirty = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
  return (
    <div className="filters">
      {tab !== "alerts" && (
        <span className="flt-group" title={t("fltVenuesHint")}>
          <em>{t("fltVenues")}</em>
          <span className="flt-venues">
            {venues.map((v) => (
              <button
                key={v}
                type="button"
                className={f.venues.includes(v) ? "on" : ""}
                title={`${VENUE_LABEL[v]}${vstat[v] ? `\n${vstat[v].text}` : ""}`}
                aria-pressed={f.venues.includes(v)}
                onClick={() => toggle(v)}
              >
                <img src={`/logos/${v}.svg`} alt={VENUE_LABEL[v]} />
                {vstat[v] && <i className={`vdot ${vstat[v].state}`} />}
              </button>
            ))}
          </span>
        </span>
      )}
      {tab === "cross" && (
        <>
          <Seg label={t("fltMarket")} value={f.kind} options={[["", all], ["perp", "perp"], ["spot", "spot"]]} onChange={(kind) => set({ kind })} />
          <Seg label={t("fltQuote")} value={f.quote} options={[["", all], ["USDT", "USDT"], ["USDC", "USDC"]]} onChange={(quote) => set({ quote })} />
          <Pick label={t("fltMinSpread")} value={f.minSpread} options={[[0, any], [0.1, "0.1%"], [0.3, "0.3%"], [0.5, "0.5%"], [1, "1%"], [2, "2%"]]} onChange={(minSpread) => set({ minSpread })} />
          <Pick label={t("fltMinVol")} value={f.minVol} options={VOL_OPTS.map(([v, s]) => [v, v ? s : any])} onChange={(minVol) => set({ minVol })} />
          <Pick label={t("fltAge")} value={f.maxAgeMin} options={[[0, any], [15, `15${t("min")}`], [60, `1${t("hour")}`], [360, `6${t("hour")}`]]} onChange={(maxAgeMin) => set({ maxAgeMin })} />
          <label className="flt-group flt-check">
            <input type="checkbox" checked={f.netPos} onChange={(e) => set({ netPos: e.target.checked })} />
            {t("fltNet")}
          </label>
          <label className="flt-group flt-check">
            <input type="checkbox" checked={f.hideBlocked} onChange={(e) => set({ hideBlocked: e.target.checked })} />
            {t("fltBlocked")}
          </label>
          <label className="flt-group flt-check">
            <input type="checkbox" checked={f.watchOnly} onChange={(e) => set({ watchOnly: e.target.checked })} />
            {t("fltWatch")}
          </label>
        </>
      )}
      {tab === "funding" && (
        <>
          <Seg label={t("fltQuote")} value={f.quote} options={[["", all], ["USDT", "USDT"], ["USDC", "USDC"]]} onChange={(quote) => set({ quote })} />
          <Pick label={t("fltFund")} value={f.fundMin} options={[[0, any], [0.01, "0.01%"], [0.03, "0.03%"], [0.05, "0.05%"], [0.1, "0.1%"]]} onChange={(fundMin) => set({ fundMin })} />
          <Seg label={t("fltPeriod")} value={f.fundPeriod} options={[[0, all], [1, "1h"], [4, "4h"], [8, "8h"]]} onChange={(fundPeriod) => set({ fundPeriod })} />
          <Seg label={t("fltSign")} value={f.fundSign} options={[["", all], ["+", "+"], ["-", "−"]]} onChange={(fundSign) => set({ fundSign })} />
          <Pick label={t("fltMinVol")} value={f.minVol} options={VOL_OPTS.map(([v, s]) => [v, v ? s : any])} onChange={(minVol) => set({ minVol })} />
          <label className="flt-group flt-check">
            <input type="checkbox" checked={f.watchOnly} onChange={(e) => set({ watchOnly: e.target.checked })} />
            {t("fltWatch")}
          </label>
        </>
      )}
      {tab === "pairs" && (
        <>
          <Pick label={t("fltCorr")} value={f.pairCorr} options={[[0, any], [0.8, "0.80"], [0.85, "0.85"], [0.9, "0.90"], [0.95, "0.95"]]} onChange={(pairCorr) => set({ pairCorr })} />
          <Pick label={t("fltZ")} value={f.pairZ} options={[[0, any], [1, "1.0"], [1.5, "1.5"], [2, "2.0"], [2.5, "2.5"]]} onChange={(pairZ) => set({ pairZ })} />
        </>
      )}
      {tab === "alerts" && (
        <Seg
          label={t("fltType")}
          value={f.alertKind}
          options={[["", all], ["threshold", t("alThreshold")], ["velocity", t("alVelocity")], ["funding", t("alFunding")], ["watch", t("alWatch")]]}
          onChange={(alertKind) => set({ alertKind })}
        />
      )}
      {dirty && (
        <button type="button" className="flt-reset" onClick={() => set(NO_FILTERS)}>
          {t("fltReset")}
        </button>
      )}
    </div>
  );
}

type SortState = { key: string; dir: 1 | -1 } | null;
type SortGet<T> = Record<string, (row: T) => number | string | null | undefined>;

// Клик: по убыванию → по возрастанию → как пришло с сервера. Текстовые столбцы начинают с А→Я.
function useSort() {
  const [sort, setSort] = useState<SortState>(null);
  const toggle = (key: string, first: 1 | -1) =>
    setSort((p) => (!p || p.key !== key ? { key, dir: first } : p.dir === first ? { key, dir: -first as 1 | -1 } : null));
  return [sort, toggle] as const;
}

function sortRows<T>(rows: T[], sort: SortState, get: SortGet<T>): T[] {
  const f = sort && get[sort.key];
  if (!sort || !f) return rows;
  return [...rows].sort((a, b) => {
    const x = f(a);
    const y = f(b);
    if (x == null || (typeof x === "number" && Number.isNaN(x))) return 1; // пустые всегда внизу
    if (y == null || (typeof y === "number" && Number.isNaN(y))) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
}

function Th({ id, sort, onSort, text, children }: {
  id: string;
  sort: SortState;
  onSort: (key: string, first: 1 | -1) => void;
  text?: boolean;
  children: React.ReactNode;
}) {
  const on = sort?.key === id;
  return (
    <th
      className={`sortable ${on ? "on" : ""}`}
      aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
      onClick={() => onSort(id, text ? 1 : -1)}
    >
      {children}
      <i>{on ? (sort!.dir === 1 ? "▲" : "▼") : "↕"}</i>
    </th>
  );
}

function freeUsdt(rows: KeyRow[], venue?: string) {
  const mine = rows.filter((row) => row.venue === venue && !row.locked && row.usdt != null);
  if (!mine.length) return null;
  return mine.reduce((sum, row) => sum + (row.usdt || 0), 0);
}

function keyState(rows: KeyRow[], venue?: string) {
  const mine = rows.filter((row) => row.venue === venue);
  if (!mine.length) return "none";
  if (mine.some((row) => !row.locked)) return "open";
  return "locked";
}

function fundText(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  const digits = Math.abs(n) >= 1 ? 2 : 3;
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fundClass(n: number | null | undefined) {
  if (n == null || Math.abs(n) < 0.00005) return "muted";
  return n > 0 ? "pos" : "neg";
}

function periodText(hours: number | null | undefined, unit: string) {
  if (hours == null) return "—";
  const n = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10);
  return `${n}${unit}`;
}

function legFund(
  map: Map<string, FundingRow>,
  venue: string,
  base: string,
  quote: string,
  rate?: number | null,
  hours?: number | null,
) {
  const known = map.get(`${venue}|${base}|${quote}`);
  return { rate: rate ?? known?.fundingPct, hours: hours ?? known?.intervalH };
}



function replaceSlice<T extends { keyId: string; kind: string }>(prev: T[], keyId: string, kind: string, rows: T[]) {
  return [...prev.filter((row) => row.keyId !== keyId || row.kind !== kind), ...rows];
}

export function CloseButtons({ row, busy, onClose }: { row: LivePos; busy: boolean; onClose: (row: LivePos, fraction?: number) => void }) {
  const { t } = useI18n();
  if (busy) return <button type="button" className="mini sell" disabled>…</button>;
  return (
    <span className="close-btns" title={t("blotCloseHint")}>
      {[0.25, 0.5].map((f) => (
        <button key={f} type="button" className="mini" onClick={() => onClose(row, f)}>{f * 100}%</button>
      ))}
      <button type="button" className="mini sell" onClick={() => onClose(row, 1)}>{t("blotClose")}</button>
    </span>
  );
}

const pnlText = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}`);

/** Позиция по открытому стакану: полоса фиксированной высоты, PnL по лучшей встречной цене этого стакана. */
function BookPos({ rows, book, closing, onClose }: {
  rows: LivePos[];
  book: OrderBook | null;
  closing: Set<string>;
  onClose: (row: LivePos, fraction?: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="book-pos">
      {!rows.length && <span className="muted">{t("noPosHere")}</span>}
      {rows.map((row) => {
        const pnl = livePnl(row, book) ?? row.pnl;
        return (
          <div className="book-pos-row" key={`${row.keyId}|${row.side}`}>
            <b className={row.side === "long" ? "pos" : "neg"}>{row.side}</b>
            <span>{row.size}</span>
            {row.entry != null && <span className="muted">@ {price(row.entry)}</span>}
            <b className={`pnl ${(pnl || 0) >= 0 ? "pos" : "neg"}`}>{pnlText(pnl)}</b>
            <CloseButtons row={row} busy={closing.has(`pos:${row.keyId}|${row.symbol}|${row.side}`)} onClose={onClose} />
          </div>
        );
      })}
    </div>
  );
}

/** Сводка выбранной связки: те же цифры, что в ленте, спред — по живому стакану. */
function SpreadFacts({ row, livePct, map, slip, now }: {
  row: CrossSpread;
  livePct: number | null;
  map: Map<string, FundingRow>;
  slip: number;
  now: number;
}) {
  const { t } = useI18n();
  const spread = livePct ?? row.spreadPct;
  const net = spread - (row.spreadPct - row.netPct); // минус те же комиссии и запас, что в ленте
  const perp = row.kind === "perp";
  const buy = legFund(map, row.buyVenue, row.base, row.quote, row.buyFundingPct, row.buyIntervalH);
  const sell = legFund(map, row.sellVenue, row.base, row.quote, row.sellFundingPct, row.sellIntervalH);
  const eight = perp ? eightFund(map, row) : null;
  const fees = (row.feesPct ?? 0).toFixed(3);
  return (
    <div className="spread-facts">
      <span>{t("spread")} <b className={spread > 0 ? "pos" : "neg"}>{spread.toFixed(3)}%</b></span>
      <span title={t("feesHint", { fees, slip: String(slip) })}>{t("net")} <b className={net > 0 ? "pos" : "neg"}>{net.toFixed(3)}%</b></span>
      <span>{t("feesShort")} <b>{fees}%</b></span>
      {perp && (
        <>
          <span title={t("fundHead")}>{VENUE_LABEL[row.buyVenue]} <b className={fundClass(buy.rate)}>{fundText(buy.rate)}</b> / {periodText(buy.hours, t("hour"))}</span>
          <span title={t("fundHead")}>{VENUE_LABEL[row.sellVenue]} <b className={fundClass(sell.rate)}>{fundText(sell.rate)}</b> / {periodText(sell.hours, t("hour"))}</span>
          <span title={t("fund8hHead")}>{t("fund8h")} <b className={fundClass(eight)}>{fundText(eight)}</b></span>
        </>
      )}
      {row.fundNextPct != null && row.fundNextAt != null && row.fundNextAt > now && (
        <span className={fundClass(row.fundNextPct)}>
          {t("payIn", { pct: fundText(row.fundNextPct), left: lifeText((row.fundNextAt - now) / 1000, t("min"), t("hour")) })}
        </span>
      )}
      {row.ageSec != null && (
        <span className="muted">
          {t("lives", { age: lifeText(row.ageSec, t("min"), t("hour")) })}
          {row.avgPct != null ? ` · ${t("avg1h", { pct: `${row.avgPct.toFixed(2)}%` })}` : ""}
        </span>
      )}
    </div>
  );
}

function OrderEdit({
  row, onAmend, onCancel,
}: {
  row: LiveOrder;
  onAmend: (row: LiveOrder, price: number) => void;
  onCancel: (row: LiveOrder) => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = useState(row.price == null ? "" : String(row.price));
  useEffect(() => setPrice(row.price == null ? "" : String(row.price)), [row.price]);
  return (
    <div className="blot-row">
      <b>{row.demo ? "demo" : "live"}</b>
      <span>{row.symbol}</span>
      <span className={row.side === "buy" ? "pos" : "neg"}>{row.side}</span>
      <input value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={(e) => {
        if (e.key === "Enter") onAmend(row, Number(price));
      }} />
      <button type="button" className="mini buy" onClick={() => onAmend(row, Number(price))}>{t("blotOk")}</button>
      <button type="button" className="mini sell" onClick={() => onCancel(row)}>{t("blotCancel")}</button>
    </div>
  );
}

function eightFund(map: Map<string, FundingRow>, row: CrossSpread) {
  if (row.funding8hPct != null) return row.funding8hPct;
  const buy = legFund(map, row.buyVenue, row.base, row.quote, row.buyFundingPct, row.buyIntervalH);
  const sell = legFund(map, row.sellVenue, row.base, row.quote, row.sellFundingPct, row.sellIntervalH);
  if (buy.rate == null || sell.rate == null || !buy.hours || !sell.hours) return null;
  return sell.rate * (8 / sell.hours) - buy.rate * (8 / buy.hours);
}

function FundLine({
  map, venue, base, quote, rate, hours, hour, title,
}: {
  map: Map<string, FundingRow>;
  venue: string;
  base: string;
  quote: string;
  rate?: number | null;
  hours?: number | null;
  hour: string;
  title: string;
}) {
  const leg = legFund(map, venue, base, quote, rate, hours);
  return (
    <div className="fund-line" title={title}>
      <span className={fundClass(leg.rate)}>{fundText(leg.rate)}</span>
      <span>{periodText(leg.hours, hour)}</span>
    </div>
  );
}

// Спред на объём по живым стаканам: купить на usd, продать то же число монет. null — стакана не хватает.
function bookExecPct(asks: { price: number; size: number }[], bids: { price: number; size: number }[], usd: number) {
  let left = usd;
  let qty = 0;
  for (const l of asks) {
    const take = Math.min(left, l.price * l.size);
    qty += take / l.price;
    left -= take;
    if (left <= 1e-9) break;
  }
  if (left > 1e-9 || qty <= 0) return null;
  let rest = qty;
  let got = 0;
  for (const l of bids) {
    const take = Math.min(rest, l.size);
    got += take * l.price;
    rest -= take;
    if (rest <= 1e-12) break;
  }
  return rest > 1e-12 ? null : ((got - usd) / usd) * 100;
}

function lifeText(sec: number, min: string, hour: string) {
  const m = Math.max(0, Math.round(sec / 60));
  return m < 60 ? `${m}${min}` : `${Math.floor(m / 60)}${hour} ${m % 60}${min}`;
}

function ageText(hours: number, hour: string, day: string) {
  if (hours < 36) return `${Math.round(hours)}${hour}`;
  return `${Math.max(1, Math.round(hours / 24))}${day}`;
}

function histDate(ts: number, lang: string) {
  return new Date(ts).toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

function money(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function researchText(status: string, t: ReturnType<typeof useI18n>["t"]) {
  if (!status || status === "idle") return t("waiting");
  if (status === "грузим свечи") return t("loadingCandles");
  if (status === "мало ликвидных перпов") return t("fewPerps");
  if (status === "готово") return t("ready");
  const count = status.match(/^считаем (\d+)/);
  if (count) return t("counting", { n: count[1] });
  return status;
}

export function App() {
  const { lang, setLang, t } = useI18n();
  const [tab, setTab] = useState<Tab>("cross");
  const [chartTarget, setChartTarget] = useState<ChartTarget>(() => {
    try {
      return { venue: "binance", symbol: "BTC/USDT:USDT", kind: "perp", base: "BTC", ...JSON.parse(localStorage.getItem("arb.target") || "{}") };
    } catch {
      return { venue: "binance", symbol: "BTC/USDT:USDT", kind: "perp", base: "BTC" };
    }
  });
  const openChart = useCallback((next: ChartTarget) => {
    setChartTarget(next);
    try {
      localStorage.setItem("arb.target", JSON.stringify(next));
    } catch {
      /* без хранилища — до перезагрузки */
    }
    setTab("chart");
  }, []);
  const spreadSortState = useSort();
  const pairSortState = useSort();
  const fundSortState = useSort();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const patchFilters = (patch: FilterPatch) => setFilters((f) => ({ ...f, ...(typeof patch === "function" ? patch(f) : patch) }));
  const viewRef = useRef("");
  const tgRef = useRef<HTMLDivElement>(null);
  const [spreads, setSpreads] = useState<CrossSpread[]>([]);
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [funding, setFunding] = useState<FundingRow[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [jrows, setJrows] = useState<JRow[]>([]);
  const [tolPct, setTolPct] = useState(0.2);
  const [settings, setSettings] = useState<Settings | null>(null);
  const starred = useMemo(() => settings?.watch ?? [], [settings?.watch]);
  const saveSettings = async (patch: Partial<Settings>) => {
    const saved = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => r.json());
    setSettings(saved);
  };
  const toggleWatch = (base: string) =>
    void saveSettings({ watch: starred.includes(base) ? starred.filter((b) => b !== base) : [...starred, base] });
  const [vstat, setVstat] = useState<Record<string, VenueStat>>({});
  useEffect(() => {
    const load = () =>
      void fetch("/api/health")
        .then((r) => r.json())
        .then((h) => setVstat(venueStats(h.quotes || [])))
        .catch(() => undefined);
    load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, []);
  const [notify, setNotify] = useState(() => typeof Notification !== "undefined" && Notification.permission === "granted");
  const [showSettings, setShowSettings] = useState(false);
  const [selSpread, setSelSpread] = useState<CrossSpread | null>(null);
  const [coinRows, setCoinRows] = useState<CoinRow[]>([]);
  const coinKey = selSpread ? `${selSpread.base}|${selSpread.quote}|${selSpread.kind}` : "";
  useEffect(() => {
    setCoinRows([]);
    if (!coinKey) return;
    const [base, quote, kind] = coinKey.split("|");
    let stop = false;
    const load = () =>
      fetch(`/api/coin?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}&kind=${kind}`)
        .then((r) => r.json())
        .then((d) => !stop && setCoinRows(d.rows || []))
        .catch(() => {});
    void load();
    const id = window.setInterval(load, 1000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [coinKey]);
  const [selPair, setSelPair] = useState<PairRow | null>(null);
  const [books, setBooks] = useState<Record<string, OrderBook>>({});
  const [tapes, setTapes] = useState<Record<string, TapeTrade[]>>({});
  const [zPoints, setZPoints] = useState<{ ts: number; z: number }[] | null>(null);
  const zRef = useRef(zPoints);
  zRef.current = zPoints;
  const pairId = useRef(selPair?.id);
  pairId.current = selPair?.id;
  const histLock = useRef(false);
  const histEnd = useRef(false);
  const [histEma, setHistEma] = useState(true);
  const [research, setResearch] = useState("");
  const [wsOk, setWsOk] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [quoteAt, setQuoteAt] = useState(0);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [ticket, setTicket] = useState<LegPick | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [positions, setPositions] = useState<LivePos[]>([]);
  // Закрытие отправлено, ответа ещё нет: кнопка заблокирована, чтобы двойной клик не ушёл вторым ордером.
  const [closing, setClosing] = useState<Set<string>>(new Set());
  // Закрытие позиции: кнопки ждут нового размера с биржи (иначе второе «50%» считается от старого). Ключ → размер до закрытия.
  const closeWait = useRef(new Map<string, number>());
  const unclose = (keys: string[]) => {
    if (!keys.length) return;
    keys.forEach((k) => closeWait.current.delete(k));
    setClosing((c) => {
      const next = new Set(c);
      keys.forEach((k) => next.delete(k));
      return next;
    });
  };
  const posSeen = useRef(new Set<string>());
  const [tapeH, setTapeH] = useState(156);
  const [chartH, setChartH] = useState(220);
  const [rightW, setRightW] = useState(() => Math.round(window.innerWidth * 0.5));
  const [quote, setQuote] = useState(100);
  const [quoteCcy, setQuoteCcy] = useState<"USDT" | "USD">("USDT");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const onKeys = useMemo(() => (rows: KeyRow[]) => setKeys(rows), []);
  const wsRef = useRef<WebSocket | null>(null);
  const watchRef = useRef<{ venue: string; symbol: string; kind: MarketKind }[]>([]);
  const prevSpread = useRef(new Map<string, number>());

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(clock);
  }, []);

  // Поиск и фильтры применяет сервер ко всем спредам и фандингу, а не только к присланным верхним строкам.
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      /* приватное окно — фильтры просто не запомнятся */
    }
    // «только избранное» при пустом списке — пустая таблица, а не всё подряд
    const only = filters.watchOnly ? (starred.length ? starred : ["\u2205"]) : [];
    viewRef.current = JSON.stringify({ type: "view", q: search, ...filters, only });
    const id = window.setTimeout(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) ws.send(viewRef.current);
    }, 200);
    return () => window.clearTimeout(id);
  }, [search, filters, starred]);

  useEffect(() => {
    if (!showSettings) return;
    const close = (e: MouseEvent) => {
      if (!tgRef.current?.contains(e.target as Node)) setShowSettings(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [showSettings]);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings);
    let ws: WebSocket | null = null;
    let stop = false;
    let retry = 0;
    const open = () => {
      if (stop) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsOk(true);
        if (watchRef.current.length) ws?.send(JSON.stringify({ type: "books", books: watchRef.current }));
        if (viewRef.current) ws?.send(viewRef.current);
      };
      ws.onclose = (ev) => {
        if (ev.code === 4401) return location.reload();  // вход истёк или сброшен: показать форму входа
        setWsOk(false);
        if (!stop) retry = window.setTimeout(open, 1000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          rows?: unknown;
          alert?: AlertEvent;
          book?: OrderBook;
          venue?: string;
          symbol?: string;
          trades?: TapeTrade[];
          settings?: Settings;
          alerts?: AlertEvent[];
          research?: { status: string };
          text?: string;
          ok?: boolean;
          kind?: string;
          keyId?: string;
        };
        if (msg.type === "hello") {
          if (msg.settings) setSettings(msg.settings);
          if (msg.alerts) setAlerts(msg.alerts);
        }
        if (msg.type === "spreads") {
          const rows = msg.rows as CrossSpread[];
          const hit: Record<string, number> = {};
          const at = Date.now();
          for (const r of rows) {
            const old = prevSpread.current.get(r.id);
            if (old != null && Math.abs(old - r.spreadPct) >= 0.0005) hit[r.id] = at;
            prevSpread.current.set(r.id, r.spreadPct);
          }
          if (Object.keys(hit).length) setFlash((f) => ({ ...f, ...hit }));
          setQuoteAt(at);
          setSpreads(rows);
        }
        if (msg.type === "pairs") {
          setPairs(msg.rows as PairRow[]);
          if (msg.research) setResearch(msg.research.status);
        }
        if (msg.type === "funding") setFunding(msg.rows as FundingRow[]);
        if (msg.type === "orders" && msg.keyId && msg.kind) {
          setOrders((prev) => replaceSlice(prev, msg.keyId!, msg.kind!, (msg.rows || []) as LiveOrder[]));
        }
        if (msg.type === "positions" && msg.keyId && msg.kind) {
          posSeen.current.add(`${msg.keyId}|${msg.kind}`);
          const rows = (msg.rows || []) as LivePos[];
          setPositions((prev) => replaceSlice(prev, msg.keyId!, msg.kind!, rows));
          const changed = [...closeWait.current].filter(([k, size]) => {
            const [keyId, symbol, side] = k.slice(4).split("|");
            if (keyId !== msg.keyId) return false;
            const now = rows.find((r) => r.symbol === symbol && r.side === side);
            return !now || now.size !== size;
          });
          unclose(changed.map(([k]) => k));
        }
        if (msg.type === "order_ack") {
          // Ошибка — разблокируем всё; успех — снимаем только связки, позиции ждут нового размера.
          if (!msg.ok) {
            closeWait.current.clear();
            setClosing(new Set());
          } else setClosing((c) => new Set([...c].filter((k) => closeWait.current.has(k))));
        }
        if (msg.type === "order_ack" && msg.text) setNotice(msg.text);
        if (msg.type === "journal") setJrows((msg.rows as JRow[]) || []);
        if (msg.type === "alert" && msg.alert) {
          setAlerts((a) => [...a.slice(-80), msg.alert!]);
          if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(msg.alert.title, { body: msg.alert.text, tag: msg.alert.kind });
          }
        }
        if (msg.type === "book" && msg.book) {
          setBooks((b) => ({ ...b, [`${msg.book!.venue}|${msg.book!.symbol}`]: msg.book! }));
        }
        if (msg.type === "tape" && msg.trades && msg.venue && msg.symbol) {
          const key = `${msg.venue}|${msg.symbol}`;
          const add = msg.trades;
          setTapes((prev) => {
            const prevRows = prev[key] || [];
            const next = add.length > 8 ? add.slice(-40) : [...prevRows, ...add].slice(-40);
            return { ...prev, [key]: next };
          });
        }
      };
    };
    open();
    return () => {
      stop = true;
      window.clearTimeout(retry);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  const watch = useMemo(() => {
    if (selSpread) {
      return [
        { venue: selSpread.buyVenue, symbol: selSpread.buySymbol, kind: selSpread.kind },
        { venue: selSpread.sellVenue, symbol: selSpread.sellSymbol, kind: selSpread.kind },
      ];
    }
    if (selPair) {
      return [
        { venue: selPair.yVenue, symbol: selPair.ySymbol, kind: "perp" as MarketKind },
        { venue: selPair.xVenue, symbol: selPair.xSymbol, kind: "perp" as MarketKind },
      ];
    }
    return [];
  }, [selSpread, selPair]);

  useEffect(() => {
    // На вкладке «Графики» подписываемся и на стакан/ленту выбранной монеты (сервер держит до 4 потоков на окно).
    const subs = tab === "chart" ? [...watch, { venue: chartTarget.venue, symbol: chartTarget.symbol, kind: chartTarget.kind }] : watch;
    watchRef.current = subs;
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "books", books: subs }));
  }, [watch, wsOk, tab, chartTarget]);

  useEffect(() => {
    if (!selPair) {
      setZPoints(null);
      return;
    }
    let stop = false;
    histEnd.current = false;
    histLock.current = false;
    const id = selPair.id;
    void fetch(`/api/pairs/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (!stop) setZPoints(d?.points || null);
      })
      .catch(() => {
        if (!stop) setZPoints(null);
      });
    return () => {
      stop = true;
    };
  }, [selPair]);

  const askOlderZ = useCallback(() => {
    const id = selPair?.id;
    const oldest = zRef.current?.[0]?.ts;
    if (!id || !oldest || histLock.current || histEnd.current) return;
    histLock.current = true;
    const n = zRef.current?.length || 0;
    void fetch(`/api/pairs/${id}?until=${oldest - 1}`)
      .then((r) => r.json())
      .then((d) => {
        if (pairId.current !== id) return;
        const next = (d?.points || []) as { ts: number; z: number }[];
        if (next.length <= n) histEnd.current = true;
        else setZPoints(next);
      })
      .catch(() => {})
      .finally(() => {
        histLock.current = false;
      });
  }, [selPair]);

  const q = search.toUpperCase();
  const [spreadSort, onSpreadSort] = spreadSortState;
  const [pairSort, onPairSort] = pairSortState;
  const [fundSort, onFundSort] = fundSortState;
  const spreadRows = spreads.filter(
    (r) =>
      !q ||
      r.base.includes(q) ||
      VENUE_LABEL[r.buyVenue].toUpperCase().includes(q) ||
      VENUE_LABEL[r.sellVenue].toUpperCase().includes(q),
  );
  const pairRows = sortRows(pairs.filter((r) =>
    (!q || r.y.includes(q) || r.x.includes(q)) &&
    (!filters.venues.length || (filters.venues.includes(r.yVenue) && filters.venues.includes(r.xVenue))) &&
    Math.abs(r.corr) >= filters.pairCorr &&
    Math.abs(r.z) >= filters.pairZ), pairSort, {
    pair: (r) => `${r.y}/${r.x}`,
    corr: (r) => r.corr,
    coint: (r) => r.cointP,
    z: (r) => Math.abs(r.z),
    life: (r) => (r.halfLifeBars >= 999 ? null : r.halfLifeBars),
    payoff: (r) => r.winRate,
  });
  const fundRows = sortRows(funding.filter((r) => !q || r.base.includes(q)), fundSort, {
    venue: (r) => VENUE_LABEL[r.venue as keyof typeof VENUE_LABEL] || r.venue,
    pair: (r) => r.base,
    funding: (r) => r.fundingPct,
    period: (r) => r.intervalH,
    basis: (r) => r.basisPct,
    volume: (r) => r.volumeUsd,
  });
  const fundByLeg = useMemo(() => {
    const map = new Map<string, FundingRow>();
    for (const row of funding) map.set(`${row.venue}|${row.base}|${row.quote}`, row);
    return map;
  }, [funding]);
  const shownSpreads = sortRows(spreadRows, spreadSort, {
    pair: (r) => r.base,
    buy: (r) => VENUE_LABEL[r.buyVenue],
    sell: (r) => VENUE_LABEL[r.sellVenue],
    spread: (r) => r.spreadPct,
    net: (r) => r.netPct,
    volume: (r) => r.volumeUsd,
  });

  const coinBuy = selSpread && coinRows.find((r) => r.venue === selSpread.buyVenue);
  const coinSell = selSpread && coinRows.find((r) => r.venue === selSpread.sellVenue);
  const fee = settings?.slippagePct ?? 0.05;
  const liveSpread = selSpread
    ? spreads.find((r) => r.id === selSpread.id) ||
      (coinBuy && coinSell ? legSpread(selSpread.base, selSpread.quote, selSpread.kind, coinBuy, coinSell, fee) : selSpread)
    : null;
  const chooseLeg = (role: "buy" | "sell", row: CoinRow) => {
    if (!liveSpread) return;
    const buy = role === "buy" ? row : coinRows.find((r) => r.venue === liveSpread.buyVenue);
    const sell = role === "sell" ? row : coinRows.find((r) => r.venue === liveSpread.sellVenue);
    if (!buy || !sell || buy.venue === sell.venue) return;
    const next = legSpread(liveSpread.base, liveSpread.quote, liveSpread.kind, buy, sell, fee);
    setSelSpread(spreads.find((r) => r.id === next.id) || next);
  };
  const leftBook = watch[0] ? books[`${watch[0].venue}|${watch[0].symbol}`] || null : null;
  const rightBook = watch[1] ? books[`${watch[1].venue}|${watch[1].symbol}`] || null : null;
  const buyPx = leftBook?.asks[0]?.price || liveSpread?.buyAsk;
  const sellPx = rightBook?.bids[0]?.price || liveSpread?.sellBid;
  const livePct = buyPx && sellPx ? ((sellPx - buyPx) / buyPx) * 100 : null;
  const age = quoteAt ? Math.max(0, (now - quoteAt) / 1000) : null;
  useEffect(() => {
    if (!ticket) return;
    const timer = window.setTimeout(() => setTicket(null), 3200);
    return () => window.clearTimeout(timer);
  }, [ticket]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const sendTrade = (body: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      setNotice(t("wsDown"));
      return;
    }
    ws.send(JSON.stringify(body));
  };
  // Несколько открытых ключей на бирже — пользователь выбирает явно, молча не берём ни один.
  const pickKey = (venue: string) => {
    const mine = keys.filter((row) => row.venue === venue && !row.locked);
    if (mine.length <= 1) return mine[0];
    const list = mine.map((row, i) => `${i + 1}) ${row.demo ? "demo" : "LIVE"} · ${row.id}`).join("\n");
    const n = Number(window.prompt(`${t("pickKey")}\n${list}`, "1"));
    return mine[n - 1];
  };
  // Боевой ключ: каждое действие, кроме отмены, — через подтверждение. Сервер без него откажет.
  const liveOk = (demo: boolean, text: string) => demo || window.confirm(`${t("liveConfirm")}\n${text}`);
  const openPair = () => {
    if (!liveSpread) return;
    if (keyState(keys, liveSpread.buyVenue) !== "open" || keyState(keys, liveSpread.sellVenue) !== "open") {
      setNotice(t("needKeys"));
      return;
    }
    const kb = pickKey(liveSpread.buyVenue);
    const ks = kb && pickKey(liveSpread.sellVenue);
    if (!kb || !ks) return;
    const demo = kb.demo && ks.demo;
    const what = `${liveSpread.base} ${liveSpread.kind}: ${VENUE_LABEL[liveSpread.buyVenue]} → ${VENUE_LABEL[liveSpread.sellVenue]} · ${quote} ${quoteCcy}`;
    if (!liveOk(demo, what)) return;
    sendTrade({
      type: "pair_open", kind: liveSpread.kind, notional: quote, tolPct, confirmLive: !demo,
      buy: { venue: liveSpread.buyVenue, symbol: liveSpread.buySymbol, keyId: kb.id },
      sell: { venue: liveSpread.sellVenue, symbol: liveSpread.sellSymbol, keyId: ks.id },
    });
  };
  // Нога перпа, по ключу которой позиции уже пришли, а этой нет: закрыли на бирже вручную или ликвидировали.
  const legGone = (row: JRow, l: JLeg) => row.kind === "perp" && posSeen.current.has(`${l.keyId}|perp`)
    && !positions.some((p) => p.keyId === l.keyId && p.symbol === l.symbol && p.size > 0
      && p.side === (l.side === "buy" ? "long" : "short"));
  const dismissPair = (row: JRow) => {
    const failed = row.status === "failed";
    if (!window.confirm(t(failed ? "jDropAsk" : "jMarkAsk", { pair: `${row.base}/${row.quote} ${row.kind}` }))) return;
    sendTrade({ type: "pair_dismiss", id: row.id });
  };
  const pairAct = (row: JRow, type: "pair_fix" | "pair_close", action?: "chase" | "unwind") => {
    const demo = row.legs.every((l) => l.demo);
    if (type === "pair_close") {
      // Закрытие необратимо — подтверждаем и на demo; на live текст уже содержит предупреждение.
      const legs = row.legs.map((l) => `${VENUE_LABEL[l.venue as VenueId] || l.venue} ${l.side === "buy" ? "sell" : "buy"} ${(l.role === "buy" ? row.qtyBuy : row.qtySell).toPrecision(4)}`).join(" · ");
      const what = t("jCloseAsk", { pair: `${row.base}/${row.quote} ${row.kind}`, legs, tol: row.tolPct });
      if (!(demo ? window.confirm(what) : liveOk(false, what))) return;
    } else if (!liveOk(demo, `${row.base}: ${action}`)) return;
    if (type === "pair_close") setClosing((c) => new Set(c).add(`pair:${row.id}`));
    sendTrade({ type, id: row.id, action, confirmLive: !demo });
  };
  const onPick = (leg: LegPick) => {
    if (keyState(keys, leg.venue) !== "open") {
      setTicket(leg);
      return;
    }
    const key = pickKey(leg.venue);
    if (!key) return;
    const side = leg.role === "buy" ? "buy" : "sell";
    const notional = leg.quote || quote;
    if (!liveOk(key.demo, `${side} ${leg.symbol} @ ${leg.price} · $${notional} · ${leg.venue}`)) return;
    sendTrade({
      type: "place",
      keyId: key.id,
      confirmLive: !key.demo,
      venue: leg.venue,
      kind: leg.kind,
      symbol: leg.symbol,
      side,
      price: leg.price,
      notional,
    });
  };
  const amendOrder = (row: LiveOrder, price: number) => {
    if (!price) return;
    if (!liveOk(row.demo, `${row.side} ${row.symbol}: ${row.price} → ${price} · ${row.venue}`)) return;
    sendTrade({
      type: "amend",
      keyId: row.keyId,
      confirmLive: !row.demo,
      venue: row.venue,
      kind: row.kind,
      symbol: row.symbol,
      orderId: row.id,
      side: row.side,
      price,
    });
  };
  const cancelOrder = (row: LiveOrder) => {
    sendTrade({ type: "cancel", keyId: row.keyId, venue: row.venue, kind: row.kind, symbol: row.symbol, orderId: row.id });
  };
  // Закрытие — без окна подтверждения: позиция уменьшается (reduce-only), скорость важнее. confirmLive сервер всё равно требует.
  const closePos = (row: LivePos, fraction = 1, limitPx?: number) => {
    const key = `pos:${row.keyId}|${row.symbol}|${row.side}`;
    if (closeWait.current.has(key)) return;
    // Лимитка на закрытие сразу размер не меняет — ждём только ответа сервера.
    if (!limitPx) {
      closeWait.current.set(key, row.size);
      window.setTimeout(() => unclose([key]), 4000); // биржа молчит — не держим кнопки вечно
    }
    setClosing((c) => new Set(c).add(key));
    sendTrade({
      type: "close", keyId: row.keyId, confirmLive: !row.demo, fraction,
      venue: row.venue, kind: row.kind, symbol: row.symbol, side: row.side,
      ...(limitPx ? { orderType: "limit", price: limitPx } : {}),
    });
  };
  // C — снять все свои ордера по открытым стаканам (связка или вкладка графика). По коду клавиши — работает и в русской раскладке.
  const cancelOpen = useRef(() => {});
  cancelOpen.current = () => {
    const legs: { venue: string; symbol: string; kind: string }[] = tab === "chart" ? [chartTarget] : watch.filter(Boolean);
    orders.filter((o) => legs.some((l) => o.venue === l.venue && o.symbol === l.symbol && o.kind === l.kind)).forEach(cancelOrder);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyC" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      cancelOpen.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const atBook = (i: 0 | 1) => (p: LivePos) =>
    !!watch[i] && p.size > 0 && p.venue === watch[i].venue && p.symbol === watch[i].symbol && p.kind === watch[i].kind;
  const otherPos = positions.filter((p) => !atBook(0)(p) && !atBook(1)(p));
  const dragTape = (e: ReactPointerEvent) => {
    const y0 = e.clientY;
    const h0 = tapeH;
    const move = (ev: PointerEvent) => setTapeH(Math.min(560, Math.max(140, h0 + y0 - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragCharts = (e: ReactPointerEvent) => {
    const y0 = e.clientY;
    const h0 = chartH;
    const max = Math.round(window.innerHeight * 0.55);
    const move = (ev: PointerEvent) => setChartH(Math.min(max, Math.max(120, h0 + ev.clientY - y0)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragWidth = (e: ReactPointerEvent) => {
    const x0 = e.clientX;
    const w0 = rightW;
    const parent = (e.currentTarget as HTMLElement).parentElement;
    const max = Math.max(520, (parent?.clientWidth || 1400) - 340);
    const move = (ev: PointerEvent) => setRightW(Math.min(max, Math.max(460, w0 + x0 - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const toastVenue = ticket ? VENUE_LABEL[ticket.venue as keyof typeof VENUE_LABEL] || ticket.venue : "";
  const toastState = ticket ? keyState(keys, ticket.venue) : "none";
  const toastText =
    toastState === "locked"
      ? t("toastLocked", { venue: toastVenue })
      : toastState === "open"
        ? t("toastOpen", { venue: toastVenue })
        : t("toastNone", { venue: toastVenue });

  return (
    <div className="app">
      <header className="top">
        <a className="sign" href="https://byttrade.com" target="_blank" rel="noreferrer">
          <span className="sign-marks" aria-hidden>
            {["binance", "bybit", "okx", "bitget"].map((id) => (
              <img key={id} src={`/logos/${id}.svg`} alt="" />
            ))}
          </span>
          <span className="sign-text">
            {t("signBefore")}<b>{t("signStrong")}</b>
          </span>
          <img className="sign-byt" src="/logos/byt.svg" alt="" />
        </a>
        <div className="logo">
          <img src="/logos/byt.svg" alt="BYTtrade" />
          <span>Arb<b>Desk</b></span>
        </div>
        <Tabs
          items={[
            { id: "cross", label: t("spreads") },
            { id: "pairs", label: t("pairs") },
            { id: "funding", label: t("funding") },
            { id: "chart", label: t("chart") },
            { id: "alerts", label: t("alerts") },
            { id: "journal", label: t("journal") },
            { id: "diary", label: t("diary") },
          ]}
          value={tab}
          onChange={(id) => setTab(id as Tab)}
        />
        <label className={`search-box ${search ? "on" : ""}`}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            type="search"
            aria-label={t("search")}
            placeholder={t("searchPh")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearch("")}
          />
          {search && (
            <button type="button" className="search-clear" aria-label="clear" onClick={() => setSearch("")}>
              ×
            </button>
          )}
        </label>
        <div className="grow" />
        <div className="tools">
        <div className="lang">
          <button type="button" className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
            EN
          </button>
          <button type="button" className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>
            RU
          </button>
        </div>
        <Keys onRows={onKeys} />
        <span className={`chip status ${wsOk ? "" : "off"}`}>
          <i className="dot" />
          <b>{wsOk ? "live" : "off"}</b>
          <span>{t("quotes")}</span>
          <span className="age">{age == null ? "—" : `${age.toFixed(1)}${t("sec")}`}</span>
        </span>
        <div className="wallet" ref={tgRef}>
          <button className={`chip ${showSettings ? "on" : ""}`} onClick={() => setShowSettings((v) => !v)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M21.6 3.4 2.4 10.8c-1.2.5-1.2 1.1-.2 1.4l4.9 1.5 1.9 5.9c.2.7.1 1 .9.9.4 0 .6-.2.8-.4l2.7-2.6 5.4 4c1 .6 1.7.3 2-.9l3.6-16.3c.4-1.4-.5-2.1-1.8-1.6zM8.7 13.6l8.8-5.5c.4-.3.8-.1.5.2l-7.5 6.8-.3 3.2-1.5-4.7z" />
            </svg>
            Telegram
          </button>
          {showSettings && settings && (
            <SettingsSheet
              value={settings}
              onClose={() => setShowSettings(false)}
              onSave={saveSettings}
            />
          )}
        </div>
        </div>
      </header>

      {tab === "diary" ? <Diary /> : tab === "chart" ? (
        <Scalp
          target={chartTarget}
          onTarget={openChart}
          keys={keys}
          positions={positions}
          orders={orders}
          books={books}
          tapes={tapes}
          closing={closing}
          send={sendTrade}
          liveOk={liveOk}
          onClose={closePos}
          onCancel={cancelOrder}
        />
      ) : (
      <div className="main">
        <div className={tab === "pairs" ? "left" : "left full"}>
          <FilterBar tab={tab} f={filters} set={patchFilters} vstat={vstat} />
          <div className="table-wrap">
            {tab === "cross" && (
              <table>
                <thead>
                  <tr>
                    <Th id="pair" text sort={spreadSort} onSort={onSpreadSort}>{t("pair")}</Th>
                    <Th id="buy" text sort={spreadSort} onSort={onSpreadSort}>{t("buy")}</Th>
                    <Th id="sell" text sort={spreadSort} onSort={onSpreadSort}>{t("sell")}</Th>
                    <Th id="spread" sort={spreadSort} onSort={onSpreadSort}>{t("spread")}</Th>
                    <Th id="net" sort={spreadSort} onSort={onSpreadSort}>{t("net")}</Th>
                    <Th id="volume" sort={spreadSort} onSort={onSpreadSort}>{t("volume")}</Th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shownSpreads.map((r) => {
                    const eight = r.kind === "perp" ? eightFund(fundByLeg, r) : null;
                    const both = r.spreadPct > 0 && eight != null && eight > 0.00005;
                    return (
                    <tr
                      key={r.id}
                      className={`${both ? "fund-spread" : ""} ${selSpread?.id === r.id ? "sel" : ""} ${now - (flash[r.id] || 0) < 800 ? "flash" : ""}`}
                      onClick={() => {
                        setSelSpread(r);
                        setSelPair(null);
                      }}
                    >
                      <td className="pair">
                        <button
                          type="button"
                          className={`star ${starred.includes(r.base) ? "on" : ""}`}
                          title={t(starred.includes(r.base) ? "watchDel" : "watchAdd")}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleWatch(r.base);
                          }}
                        >
                          {starred.includes(r.base) ? "★" : "☆"}
                        </button>
                        {r.base}/{r.quote} <span className="muted">{r.kind}</span>
                        {r.transfer && r.transfer !== "ok" && (
                          <span
                            className={`tr-flag ${r.transfer}`}
                            title={r.transfer === "blocked"
                              ? t(r.transferWhy === "withdraw" ? "wdClosed" : "depClosed", { base: r.base, venue: VENUE_LABEL[r.transferVenue as VenueId] || "" })
                              : t("trUnknown")}
                          >
                            {r.transfer === "blocked" ? "⛔" : "?"}
                          </span>
                        )}
                      </td>
                      <td className="leg">
                        <div className="leg-top">
                          <Venue id={r.buyVenue} /> <span className="num">{r.buyAsk}</span>
                        </div>
                        {r.kind === "perp" && (
                          <FundLine
                            map={fundByLeg}
                            venue={r.buyVenue}
                            base={r.base}
                            quote={r.quote}
                            rate={r.buyFundingPct}
                            hours={r.buyIntervalH}
                            hour={t("hour")}
                            title={t("fundHead")}
                          />
                        )}
                      </td>
                      <td className="leg">
                        <div className="leg-top">
                          <Venue id={r.sellVenue} /> <span className="num">{r.sellBid}</span>
                        </div>
                        {r.kind === "perp" && (
                          <FundLine
                            map={fundByLeg}
                            venue={r.sellVenue}
                            base={r.base}
                            quote={r.quote}
                            rate={r.sellFundingPct}
                            hours={r.sellIntervalH}
                            hour={t("hour")}
                            title={t("fundHead")}
                          />
                        )}
                      </td>
                      <td className="leg">
                        <div className="pos">{r.spreadPct.toFixed(3)}%</div>
                        {r.execUsd != null && (
                          <div className={`fund-line ${r.execPct == null ? "neg" : r.execPct > 0 ? "pos" : "neg"}`}>
                            {r.execPct == null ? t("thinBook", { usd: money(r.execUsd) }) : `${t("onSize", { usd: money(r.execUsd) })} ${r.execPct.toFixed(3)}%`}
                          </div>
                        )}
                        {r.ageSec != null && (
                          <div className={`fund-line life ${r.ageSec > 3600 ? "old" : ""}`}>
                            {t("lives", { age: lifeText(r.ageSec, t("min"), t("hour")) })}
                            {r.avgPct != null ? ` · ${t("avg1h", { pct: `${r.avgPct.toFixed(2)}%` })}` : ""}
                          </div>
                        )}
                      </td>
                      <td className="leg">
                        <div
                          className={r.netPct > 0 ? "pos" : "neg"}
                          title={t("feesHint", { fees: (r.feesPct ?? 0).toFixed(3), slip: String(settings?.slippagePct ?? 0) })}
                        >
                          {r.netPct.toFixed(3)}%
                        </div>
                        {r.kind === "perp" && (
                          <div className={`fund-line ${fundClass(eight)}`} title={t("fund8hHead")}>
                            8{t("hour")} {fundText(eight)}
                          </div>
                        )}
                        {r.fundNextPct != null && r.fundNextAt != null && r.fundNextAt > now && (
                          <div className={`fund-line ${fundClass(r.fundNextPct)}`}>
                            {t("payIn", { pct: fundText(r.fundNextPct), left: lifeText((r.fundNextAt - now) / 1000, t("min"), t("hour")) })}
                          </div>
                        )}
                      </td>
                      <td>{money(r.volumeUsd)}</td>
                      <td className="acts">
                        <button
                          type="button"
                          className="mini buy"
                          title={t("buyTitle", { base: r.base, venue: VENUE_LABEL[r.buyVenue], px: r.buyAsk })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelSpread(r);
                            setSelPair(null);
                            onPick({
                              role: "buy",
                              side: "ask",
                              venue: r.buyVenue,
                              symbol: r.buySymbol,
                              kind: r.kind,
                              price: r.buyAsk,
                              size: r.buyAsk ? quote / r.buyAsk : 0,
                              quote,
                              quoteCcy,
                            });
                          }}
                        >
                          {t("buyBtn")}
                        </button>
                        <button
                          type="button"
                          className="mini sell"
                          title={t("sellTitle", { base: r.base, venue: VENUE_LABEL[r.sellVenue], px: r.sellBid })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelSpread(r);
                            setSelPair(null);
                            onPick({
                              role: "sell",
                              side: "bid",
                              venue: r.sellVenue,
                              symbol: r.sellSymbol,
                              kind: r.kind,
                              price: r.sellBid,
                              size: r.sellBid ? quote / r.sellBid : 0,
                              quote,
                              quoteCcy,
                            });
                          }}
                        >
                          {t("sellBtn")}
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {tab === "pairs" && (
              <table>
                <thead>
                  <tr>
                    <Th id="pair" text sort={pairSort} onSort={onPairSort}>Y / X</Th>
                    <Th id="corr" sort={pairSort} onSort={onPairSort}>corr</Th>
                    <Th id="coint" text sort={pairSort} onSort={onPairSort}>coint p</Th>
                    <Th id="z" sort={pairSort} onSort={onPairSort}>|z|</Th>
                    <Th id="life" text sort={pairSort} onSort={onPairSort}>{t("life")}</Th>
                    <Th id="payoff" sort={pairSort} onSort={onPairSort}>{t("payoff")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {pairRows.map((r) => (
                    <tr
                      key={r.id}
                      className={selPair?.id === r.id ? "sel" : ""}
                      onClick={() => {
                        setSelPair(r);
                        setSelSpread(null);
                      }}
                    >
                      <td>
                        {r.y} / {r.x}
                      </td>
                      <td>{r.corr.toFixed(2)}</td>
                      <td>{r.cointP.toFixed(3)}</td>
                      <td className={Math.abs(r.z) >= 2 ? "neg" : "pos"}>{r.z.toFixed(2)}</td>
                      <td className="pair-life">
                        <span>{t("spreadLife")} {r.halfLifeBars >= 999 ? "—" : ageText(r.halfLifeHours ?? r.halfLifeBars * 4, t("hour"), t("day"))}</span>
                        <span>{t("cointLife")} {r.cointAgeBars == null ? "—" : r.cointAgeBars === 0 ? t("cointNone") : ageText(r.cointAgeBars * 4, t("hour"), t("day"))}</span>
                      </td>
                      <td>
                        {(r.winRate * 100).toFixed(0)}% · {r.trades} · {r.avgHours.toFixed(0)}{t("hour")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "funding" && (
              <table>
                <thead>
                  <tr>
                    <Th id="venue" text sort={fundSort} onSort={onFundSort}>{t("venue")}</Th>
                    <Th id="pair" text sort={fundSort} onSort={onFundSort}>{t("pair")}</Th>
                    <Th id="funding" sort={fundSort} onSort={onFundSort}>funding</Th>
                    <Th id="period" text sort={fundSort} onSort={onFundSort}>{t("fundPeriod")}</Th>
                    <Th id="basis" sort={fundSort} onSort={onFundSort}>basis</Th>
                    <Th id="volume" sort={fundSort} onSort={onFundSort}>{t("volume")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {fundRows.map((r) => (
                    <tr key={r.id}>
                      <td><Venue id={r.venue} /></td>
                      <td>{r.base}</td>
                      <td className={r.fundingPct >= 0 ? "pos" : "neg"}>{r.fundingPct.toFixed(4)}%</td>
                      <td>{periodText(r.intervalH, t("hour"))}</td>
                      <td className={r.basisPct >= 0 ? "pos" : "neg"}>{r.basisPct.toFixed(3)}%</td>
                      <td>{money(r.volumeUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "journal" && (
              <table>
                <thead>
                  <tr>
                    <th>{t("jTime")}</th>
                    <th>{t("jPair")}</th>
                    <th>{t("jLegs")}</th>
                    <th>{t("jSize")}</th>
                    <th>{t("jEntry")}</th>
                    <th>{t("jStatus")}</th>
                    <th>PnL</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jrows.length === 0 && (
                    <tr><td colSpan={8} className="muted">{t("noJournal")}</td></tr>
                  )}
                  {jrows.map((r) => (
                    <tr key={r.id}>
                      <td className="muted">{new Date(r.ts).toLocaleString(lang === "ru" ? "ru-RU" : "en-GB", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                      <td>{r.base}/{r.quote} <span className="muted">{r.kind}{r.legs.every((l) => l.demo) ? " · demo" : " · LIVE"}</span></td>
                      <td className="leg">
                        {r.legs.map((l) => (
                          <div key={l.role} title={l.error || ""} className={l.error ? "neg" : ""}>
                            <Venue id={l.venue} /> {l.side} {l.filled.toPrecision(4)}{l.avg ? ` @ ${price(l.avg)}` : ""}
                            {(r.status === "open" || r.status === "partial") && legGone(r, l) && (
                              <span className="gone" title={t("jGoneHint")}> · {t("jGone")}</span>
                            )}
                          </div>
                        ))}
                      </td>
                      <td>{Math.min(r.qtyBuy, r.qtySell).toPrecision(4)}{Math.abs(r.imbalance) > 0 ? <div className="neg">Δ {r.imbalance.toPrecision(3)}</div> : null}</td>
                      <td>{r.entrySpreadPct == null ? "—" : `${r.entrySpreadPct.toFixed(3)}%`}</td>
                      <td className={`jst ${r.status}`}>{t(({ open: "stOpen", partial: "stPartial", closed: "stClosed", failed: "stFailed", closing: "stClosing" } as const)[r.status as "open"] || "stOpen")}</td>
                      <td className={r.pnl == null ? "muted" : r.pnl >= 0 ? "pos" : "neg"} title={r.legs.some((l) => l.exit?.outside) ? t("jApproxHint") : undefined}>
                        {r.pnl == null ? "—" : `${r.legs.some((l) => l.exit?.outside) ? "≈ " : ""}${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}`}
                      </td>
                      <td className="acts">
                        {r.status === "partial" && (
                          <>
                            <button type="button" className="mini buy" title={t("jChaseHint")} onClick={() => pairAct(r, "pair_fix", "chase")}>{t("jChase")}</button>
                            <button type="button" className="mini" title={t("jUnwindHint")} onClick={() => pairAct(r, "pair_fix", "unwind")}>{t("jUnwind")}</button>
                          </>
                        )}
                        {(r.status === "open" || r.status === "partial") && (
                          <button type="button" className="mini sell" title={t("jCloseHint")} disabled={closing.has(`pair:${r.id}`)} onClick={() => pairAct(r, "pair_close")}>{closing.has(`pair:${r.id}`) ? "…" : t("jClose")}</button>
                        )}
                        {(r.status === "open" || r.status === "partial") && (
                          <button type="button" className={`mini${r.legs.some((l) => legGone(r, l)) ? " warn" : ""}`} title={t("jMarkHint")} onClick={() => dismissPair(r)}>{t("jMark")}</button>
                        )}
                        {r.status === "failed" && (
                          <button type="button" className="mini" title={t("jDropHint")} onClick={() => dismissPair(r)}>{t("jDrop")}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "alerts" && (
              <div className="alerts">
                {typeof Notification !== "undefined" && (
                  <button
                    type="button"
                    className="mini"
                    disabled={notify}
                    onClick={() => void Notification.requestPermission().then((p) => setNotify(p === "granted"))}
                  >
                    {t(notify ? "notifyOk" : "notifyOn")}
                  </button>
                )}
                {alerts.length === 0 && <div className="empty">{t("noAlerts")}</div>}
                {[...alerts].reverse().filter((a) => !filters.alertKind || a.kind === filters.alertKind).map((a) => (
                  <div className="alert" key={a.id}>
                    <div className="t">{a.title}</div>
                    <div>{a.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pair-hist">
            <div className="pair-hist-cap">
              {selPair && zPoints && zPoints.length ? (
                <>
                  <b>{selPair.y} / {selPair.x}</b>
                  <span>{t("spreadLife")} {selPair.halfLifeBars >= 999 ? "—" : ageText(selPair.halfLifeHours ?? selPair.halfLifeBars * 4, t("hour"), t("day"))}</span>
                  <span>{t("cointLife")} {selPair.cointAgeBars == null ? "—" : selPair.cointAgeBars === 0 ? t("cointNone") : ageText(selPair.cointAgeBars * 4, t("hour"), t("day"))}</span>
                  <span>{histDate(zPoints[0].ts, lang)} – {histDate(zPoints[zPoints.length - 1].ts, lang)}</span>
                </>
              ) : (
                <span>{t("pairHist")}</span>
              )}
              <button type="button" className={histEma ? "on" : ""} aria-pressed={histEma} onClick={() => setHistEma((v) => !v)}>
                EMA 200
              </button>
            </div>
            <SpreadChart points={tab === "pairs" ? zPoints : null} ema={histEma} onOlder={askOlderZ} />
          </div>
        </div>
        <div className="split-x" onPointerDown={dragWidth} title={t("dragSplit")} />
        <div className={`right ${liveSpread || selPair ? "has-charts" : ""}`} style={{ width: rightW }}>
          <div className="arb-banner">
            <div className="leg">
              <b>{t("weBuy")}</b>
              <strong className="pos">
                {liveSpread ? <Venue id={liveSpread.buyVenue} /> : "—"}
                {buyPx ? <span className="num">{buyPx}</span> : null}
              </strong>
            </div>
            <div className="midpct">
              <b>{livePct == null ? "—" : `${livePct.toFixed(3)}%`}</b>
              <span>{liveSpread ? `${liveSpread.base}/${liveSpread.quote} ${liveSpread.kind}` : t("noLink")}</span>
              {liveSpread && leftBook && rightBook && (() => {
                const pct = bookExecPct(leftBook.asks, rightBook.bids, quote);
                return (
                  <span className={pct == null ? "neg" : pct > 0 ? "pos" : "neg"}>
                    {pct == null ? t("thinBook", { usd: String(quote) }) : `${t("onSize", { usd: String(quote) })} ${pct.toFixed(3)}%`}
                  </span>
                );
              })()}
            </div>
            <div className="leg" style={{ textAlign: "right" }}>
              <b>{t("weSell")}</b>
              <strong className="neg">
                {sellPx ? <span className="num">{sellPx}</span> : null}
                {liveSpread ? <Venue id={liveSpread.sellVenue} /> : "—"}
              </strong>
            </div>
            {liveSpread && (
              <SpreadFacts row={liveSpread} livePct={livePct} map={fundByLeg} slip={settings?.slippagePct ?? 0} now={now} />
            )}
            {liveSpread && (
              <div className="pair-exec">
                <button type="button" className="pair-open" title={t("openPairHint")} onClick={openPair}>
                  ⇄ {t("openPair", { usd: `${quote} ${quoteCcy}` })}
                </button>
                <label title={t("tol")}>
                  ±
                  <select value={tolPct} onChange={(e) => setTolPct(Number(e.target.value))}>
                    {[0.1, 0.2, 0.5, 1].map((v) => <option key={v} value={v}>{v}%</option>)}
                  </select>
                </label>
              </div>
            )}
            {liveSpread && coinRows.length > 1 && (
              <CoinStrip
                rows={coinRows}
                buyVenue={liveSpread.buyVenue}
                sellVenue={liveSpread.sellVenue}
                onPick={chooseLeg}
              />
            )}
            {(orders.length > 0 || otherPos.length > 0) && (
              <div className="blotter">
                {orders.length > 0 && <span className="muted">{t("blotOrders")}</span>}
                {orders.map((row) => (
                  <OrderEdit key={`${row.venue}|${row.id}`} row={row} onAmend={amendOrder} onCancel={cancelOrder} />
                ))}
                {otherPos.length > 0 && <span className="muted">{t("blotPos")}</span>}
                {otherPos.map((row) => (
                  <div className="blot-row" key={`${row.venue}|${row.symbol}|${row.side}`}>
                    <b>{row.demo ? "demo" : "live"}</b>
                    <Venue id={row.venue as VenueId} />
                    <button type="button" className="link" title={t("chOpenChart")}
                      onClick={() => openChart({ venue: row.venue as VenueId, symbol: row.symbol, kind: row.kind as MarketKind, base: row.symbol.split("/")[0] })}>
                      {row.symbol}
                    </button>
                    <span className={row.side === "long" ? "pos" : "neg"}>{row.side}</span>
                    <span>{row.size}</span>
                    {row.entry != null && <span className="muted">@ {price(row.entry)}</span>}
                    {(() => {
                      const pnl = livePnl(row, books[`${row.venue}|${row.symbol}`]) ?? row.pnl;
                      return <span className={(pnl || 0) >= 0 ? "pos" : "neg"}>{pnlText(pnl)}</span>;
                    })()}
                    <CloseButtons row={row} busy={closing.has(`pos:${row.keyId}|${row.symbol}|${row.side}`)} onClose={closePos} />
                  </div>
                ))}
              </div>
            )}
          </div>
          {(liveSpread || selPair) && (
            <div className="minis-wrap" style={{ height: chartH }}>
              {liveSpread ? (
                <MiniCharts
                  key="pct"
                  id={liveSpread.id}
                  kind={liveSpread.kind}
                  buyVenue={liveSpread.buyVenue}
                  sellVenue={liveSpread.sellVenue}
                  buySymbol={liveSpread.buySymbol}
                  sellSymbol={liveSpread.sellSymbol}
                  spreadTitle={t("spreadMove")}
                  buyTitle={VENUE_LABEL[liveSpread.buyVenue]}
                  sellTitle={VENUE_LABEL[liveSpread.sellVenue]}
                />
              ) : selPair && (
                <MiniCharts
                  key="pair"
                  id={selPair.id}
                  kind="perp"
                  initialTf="4h"
                  buyVenue={selPair.yVenue}
                  sellVenue={selPair.xVenue}
                  buySymbol={selPair.ySymbol}
                  sellSymbol={selPair.xSymbol}
                  spreadTitle={t("spreadMove")}
                  buyTitle={`${selPair.y} ${VENUE_LABEL[selPair.yVenue]}`}
                  sellTitle={`${selPair.x} ${VENUE_LABEL[selPair.xVenue]}`}
                />
              )}
              <button type="button" className="chart-grip" onPointerDown={dragCharts} title={t("dragCharts")} />
            </div>
          )}
          <div className="books">
            <div className="book buy" style={{ "--tape": `${tapeH}px` } as CSSProperties}>
              <Book
                book={leftBook}
                role="buy"
                venue={watch[0]?.venue}
                symbol={watch[0]?.symbol}
                kind={watch[0]?.kind}
                updatedAt={now}
                onPick={onPick}
                quote={quote}
                quoteCcy={quoteCcy}
                onQuote={setQuote}
                onCcy={setQuoteCcy}
                freeUsdt={freeUsdt(keys, watch[0]?.venue)}
                orders={orders}
                onCancel={cancelOrder}
              />
              <BookPos rows={positions.filter(atBook(0))} book={leftBook} closing={closing} onClose={closePos} />
              <Tape
                trades={watch[0] ? tapes[`${watch[0].venue}|${watch[0].symbol}`] || [] : []}
                title={t("buyTape")}
                onDrag={dragTape}
              />
            </div>
            <div className="book sell" style={{ "--tape": `${tapeH}px` } as CSSProperties}>
              <Book
                book={rightBook}
                role="sell"
                venue={watch[1]?.venue}
                symbol={watch[1]?.symbol}
                kind={watch[1]?.kind}
                updatedAt={now}
                onPick={onPick}
                quote={quote}
                quoteCcy={quoteCcy}
                onQuote={setQuote}
                onCcy={setQuoteCcy}
                freeUsdt={freeUsdt(keys, watch[1]?.venue)}
                orders={orders}
                onCancel={cancelOrder}
              />
              <BookPos rows={positions.filter(atBook(1))} book={rightBook} closing={closing} onClose={closePos} />
              <Tape
                trades={watch[1] ? tapes[`${watch[1].venue}|${watch[1].symbol}`] || [] : []}
                title={t("sellTape")}
                onDrag={dragTape}
              />
            </div>
          </div>
        </div>
      </div>
      )}

      {(notice || ticket) && (
        <div className="toast" role="status">
          <span className="toast-mark warn">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 8v5" />
              <path d="M12 16.2h.01" />
            </svg>
          </span>
          <span>{notice ? srvText(notice, lang) : toastText}</span>
        </div>
      )}
      <footer className="foot">
        <span>{t("pairsLabel")} {researchText(research, t)}</span>
        <span>{t("spreadsLabel")} {spreads.length}</span>
        <Updates />
        <Logout />
        <span className="risk">
          {t("riskText")}
        </span>
      </footer>

    </div>
  );
}

function CoinStrip({ rows, buyVenue, sellVenue, onPick }: {
  rows: CoinRow[];
  buyVenue: string;
  sellVenue: string;
  onPick: (role: "buy" | "sell", row: CoinRow) => void;
}) {
  const { t } = useI18n();
  const same = rows.filter((r) => !r.odd);
  const minAsk = Math.min(...same.map((r) => r.ask));
  const maxBid = Math.max(...same.map((r) => r.bid));
  return (
    <div className="coin-strip">
      <span className="muted">{t("coinAll")}</span>
      {rows.map((r) => (
        <div
          key={r.venue}
          className={`coin-v ${r.venue === buyVenue ? "is-buy" : ""} ${r.venue === sellVenue ? "is-sell" : ""} ${r.ageSec > 10 ? "stale" : ""} ${r.odd ? "odd" : ""}`}
          title={`${VENUE_LABEL[r.venue] || r.venue} · ${r.ws ? "WS" : "REST"} · ${r.ageSec}s · ${money(r.volumeUsd)}${r.odd ? `\n${t("oddCoin")}` : ""}`}
        >
          <Venue id={r.venue} />
          <button
            type="button"
            className={`px ask ${r.ask === minAsk ? "best" : ""}`}
            disabled={r.venue === sellVenue}
            title={r.venue === sellVenue ? t("sameVenue") : t("buyHere")}
            onClick={() => onPick("buy", r)}
          >
            {price(r.ask)}
          </button>
          <button
            type="button"
            className={`px bid ${r.bid === maxBid ? "best" : ""}`}
            disabled={r.venue === buyVenue}
            title={r.venue === buyVenue ? t("sameVenue") : t("sellHere")}
            onClick={() => onPick("sell", r)}
          >
            {price(r.bid)}
          </button>
        </div>
      ))}
    </div>
  );
}

function SettingsSheet({
  value,
  onClose,
  onSave,
}: {
  value: Settings;
  onClose: () => void;
  onSave: (s: Settings) => Promise<void>;
}) {
  const { t } = useI18n();
  const [s, setS] = useState(value);
  const [test, setTest] = useState("");
  return (
    <div className="tg-drop">
      <div className="tg-head">
        <b>Telegram</b>
        <button type="button" className="ghost" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="tg-note">{t("tgNote")}</p>
      <label className="field">
        <span>{t("botToken")}</span>
        <input value={s.telegramToken} autoComplete="off" onChange={(e) => setS({ ...s, telegramToken: e.target.value })} />
      </label>
      <label className="field">
        <span>{t("chatId")}</span>
        <input value={s.telegramChatId} autoComplete="off" onChange={(e) => setS({ ...s, telegramChatId: e.target.value })} />
      </label>
      <div className="row2">
        <label className="field">
          <span>{t("spreadMin")}</span>
          <input type="number" value={s.minSpreadPct} onChange={(e) => setS({ ...s, minSpreadPct: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("widen")}</span>
          <input type="number" value={s.velocityPct} onChange={(e) => setS({ ...s, velocityPct: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row2">
        <label className="field">
          <span>{t("windowSec")}</span>
          <input type="number" value={s.velocityWindowSec} onChange={(e) => setS({ ...s, velocityWindowSec: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("cooldown")}</span>
          <input type="number" value={s.cooldownSec} onChange={(e) => setS({ ...s, cooldownSec: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row2">
        <label className="field">
          <span>{t("minVol")}</span>
          <input type="number" value={s.minVolumeUsd} onChange={(e) => setS({ ...s, minVolumeUsd: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("fundingPct")}</span>
          <input type="number" value={s.minFundingPct} onChange={(e) => setS({ ...s, minFundingPct: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row2">
        <label className="field">
          <span>{t("tgMax")}</span>
          <input type="number" value={s.tgMaxPerMin} onChange={(e) => setS({ ...s, tgMaxPerMin: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("quoteAge")}</span>
          <input type="number" value={s.maxQuoteAgeSec} onChange={(e) => setS({ ...s, maxQuoteAgeSec: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row2">
        <label className="field">
          <span>{t("slippage")}</span>
          <input type="number" step="0.01" value={s.slippagePct} onChange={(e) => setS({ ...s, slippagePct: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("sizeUsd")}</span>
          <input type="number" value={s.sizeUsd} onChange={(e) => setS({ ...s, sizeUsd: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row2">
        <label className="field">
          <span>{t("watchNet")}</span>
          <input type="number" step="0.05" value={s.watchNetPct} onChange={(e) => setS({ ...s, watchNetPct: Number(e.target.value) })} />
        </label>
      </div>
      <div className="tg-actions">
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            await onSave(s);
            const r = await fetch("/api/telegram/test", { method: "POST" }).then((x) => x.json());
            setTest(r.ok ? t("sent") : r.error || t("error"));
          }}
        >
          {t("test")}
        </button>
        <button
          type="button"
          className="save"
          onClick={async () => {
            await onSave(s);
            onClose();
          }}
        >
          {t("save")}
        </button>
      </div>
      {test && <p className="tg-note">{test}</p>}
    </div>
  );
}
