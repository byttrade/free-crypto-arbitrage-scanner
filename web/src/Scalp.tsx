// Вкладка «Графики»: свечи монеты с индикаторами, стакан-лесенка и быстрые ордера для скальпинга.
import {
  CandlestickSeries, HistogramSeries, LineSeries,
  createChart, CrosshairMode, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type MouseEventParams, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { bookTick, onRung, pnlOf, tickLadder, tickText, type Rung } from "./ladder";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chartText, look, tickFormat } from "./Chart";
import { GroupPick, PnlText, price as fmt, QUOTE_CHIPS, Venue } from "./Dom";
import { useI18n } from "./i18n";
import { applyTrade, bollinger, ema, macd, mergeLatest, rsi, sma, vwap, type Bar, type Val } from "./indicators";
import type { KeyRow } from "./Keys";
import type { LiveOrder, LivePos, MarketKind, OrderBook, TapeTrade, VenueId } from "./types";
import { VENUE_LABEL } from "./types";

export type ChartTarget = { venue: VenueId; symbol: string; kind: MarketKind; base: string };

type Tf = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
const TFS: Tf[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const TF_MS: Record<Tf, number> = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 144e5, "1d": 864e5 };

type Ind = {
  ema: number[]; sma: number; smaOn: boolean; vwap: boolean; bb: boolean; vol: boolean; rsi: boolean; macd: boolean;
};
const IND0: Ind = { ema: [9, 21], sma: 50, smaOn: false, vwap: true, bb: false, vol: true, rsi: true, macd: false };
const EMA_COLORS = ["#c8f542", "#f5a524", "#1e90ff", "#e879f9"];
const UP = "#17c964";
const DOWN = "#f31260";

function load<T>(key: string, init: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...init, ...JSON.parse(v) } : init;
  } catch {
    return init;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* приватное окно — настройки на сеанс */
  }
}

const qty = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

const line = (bars: Bar[], vals: Val[]) =>
  vals.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [{ time: (bars[i].t / 1000) as UTCTimestamp, value: v }]));

/** Тейк и стоп позиции: поле цены и кнопка на каждую ногу, × снимает стоящую. */
function TpSl({ p, onSet, onClear }: {
  p: LivePos;
  onSet: (leg: "tp" | "sl", px: number) => void;
  onClear: (leg: "tp" | "sl") => void;
}) {
  const { t } = useI18n();
  const [vals, setVals] = useState({ tp: "", sl: "" });
  // Каждое поле — со своей ногой: пришёл новый TP — не стираем набранный, но не отправленный SL.
  useEffect(() => setVals((x) => ({ ...x, tp: p.tp ? String(p.tp) : "" })), [p.tp]);
  useEffect(() => setVals((x) => ({ ...x, sl: p.sl ? String(p.sl) : "" })), [p.sl]);
  return (
    <div className="tpsl" title={t("tpslHint")}>
      {(["tp", "sl"] as const).map((leg) => {
        const v = Number(vals[leg]);
        const cur = p[leg];
        return (
          <div key={leg} className={`tpsl-row ${leg}`}>
            <b>{leg.toUpperCase()}</b>
            <input value={vals[leg]} inputMode="decimal" placeholder="—" aria-label={leg.toUpperCase()}
              onChange={(e) => setVals((x) => ({ ...x, [leg]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && v > 0 && onSet(leg, v)} />
            <button type="button" className="mini" disabled={!(v > 0) || v === cur} onClick={() => onSet(leg, v)}>{t("tpslSet")}</button>
            {cur ? <button type="button" className="mini sell" title={t("tpslClear", { leg: leg.toUpperCase() })} onClick={() => onClear(leg)}>×</button> : null}
          </div>
        );
      })}
    </div>
  );
}

async function fetchBars(t: ChartTarget, tf: Tf, limit: number, until?: number): Promise<Bar[]> {
  const q = new URLSearchParams({ venue: t.venue, symbol: t.symbol, kind: t.kind, tf, limit: String(limit) });
  if (until) q.set("until", String(until));
  const r = await fetch(`/api/candles?${q}`);
  return ((await r.json()).candles || []) as Bar[];
}

export function Scalp({
  target, onTarget, keys, positions, orders, books, tapes, closing, send, liveOk, onClose, onCancel, onAmend,
  group, onGroup, sound, onSound,
}: {
  target: ChartTarget;
  onTarget: (t: ChartTarget) => void;
  keys: KeyRow[];
  positions: LivePos[];
  orders: LiveOrder[];
  books: Record<string, OrderBook>;
  tapes: Record<string, TapeTrade[]>;
  closing: Set<string>;
  send: (body: Record<string, unknown>) => void;
  liveOk: (demo: boolean, text: string) => boolean;
  onClose: (row: LivePos, fraction?: number, limitPx?: number) => void;
  onCancel: (row: LiveOrder) => void;
  onAmend: (row: LiveOrder, price: number) => void;
  group: number;
  onGroup: (n: number) => void;
  sound: boolean;
  onSound: (on: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const [tf, setTf] = useState<Tf>(() => load("arb.chart", { tf: "1m" as Tf }).tf);
  const [ind, setInd] = useState<Ind>(() => load("arb.ind", IND0));
  const [showInd, setShowInd] = useState(false);
  const [bars, setBars] = useState<Bar[]>([]);
  const [hover, setHover] = useState<Bar | null>(null);
  const [amount, setAmount] = useState(() => load("arb.scalp", { amount: 50 }).amount);
  const [oneClick, setOneClick] = useState(() => sessionStorage.getItem("arb.oneclick") === "1");
  const [keyId, setKeyId] = useState("");
  const [coin, setCoin] = useState(target.base);
  const [venues, setVenues] = useState<{ venue: VenueId; symbol: string }[]>([]);
  useEffect(() => save("arb.chart", { tf }), [tf]);
  useEffect(() => save("arb.ind", ind), [ind]);
  useEffect(() => save("arb.scalp", { amount }), [amount]);
  useEffect(() => setCoin(target.base), [target.base]);

  const bookKey = `${target.venue}|${target.symbol}`;
  const book = books[bookKey];
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  const myKeys = keys.filter((k) => k.venue === target.venue && !k.locked);
  const key = myKeys.find((k) => k.id === keyId) || myKeys[0];
  const myPos = positions.filter((p) => p.venue === target.venue && p.symbol === target.symbol && p.kind === target.kind && p.size > 0);
  const myOrders = orders.filter((o) => o.venue === target.venue && o.symbol === target.symbol && o.kind === target.kind);

  // ---------- свечи: история + живая лента ----------
  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;
  const lastTrade = useRef(0);
  const older = useRef({ busy: false, end: false });
  useEffect(() => {
    let stop = false;
    setBars([]);
    setHover(null);
    older.current = { busy: false, end: false };
    lastTrade.current = Date.now();
    fetchBars(target, tf, 500).then((b) => !stop && setBars(b)).catch(() => {});
    // Биржа — источник истины: раз в 10 с подтягиваем последние свечи поверх собранных из ленты.
    const timer = window.setInterval(() => {
      fetchBars(target, tf, 3).then((b) => !stop && setBars((prev) => (prev.length ? mergeLatest(prev, b) : prev))).catch(() => {});
    }, 10_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [target, tf]);
  const trades = tapes[bookKey];
  useEffect(() => {
    if (!trades?.length || !barsRef.current.length) return;
    const fresh = trades.filter((x) => x.ts > lastTrade.current);
    if (!fresh.length) return;
    lastTrade.current = Math.max(...fresh.map((x) => x.ts));
    setBars((prev) => fresh.reduce((acc, x) => applyTrade(acc, TF_MS[tf], x.ts, x.price, x.size), prev));
  }, [trades, tf]);
  const askOlder = useCallback(() => {
    const first = barsRef.current[0];
    if (!first || older.current.busy || older.current.end) return;
    older.current.busy = true;
    fetchBars(target, tf, 500, first.t - 1)
      .then((b) => {
        const add = b.filter((x) => x.t < first.t);
        if (!add.length) older.current.end = true;
        else setBars((prev) => [...add, ...prev]);
      })
      .catch(() => {})
      .finally(() => (older.current.busy = false));
  }, [target, tf]);

  // ---------- графики ----------
  const mainRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{ main?: IChartApi }>({});
  const series = useRef<{ candle?: ISeriesApi<"Candlestick">; vol?: ISeriesApi<"Histogram">; over: ISeriesApi<"Line">[];
    rsi?: ISeriesApi<"Line">; macd?: ISeriesApi<"Line">; sig?: ISeriesApi<"Line">; hist?: ISeriesApi<"Histogram"> }>({ over: [] });
  const olderRef = useRef(askOlder);
  const [gen, setGen] = useState(0); // графики пересозданы — данные и линии рисуем заново
  olderRef.current = askOlder;

  useEffect(() => {
    if (!mainRef.current) return;
    const base = { ...look, ...chartText(lang), crosshair: { ...look.crosshair, mode: CrosshairMode.Normal } };
    // Один график, панели снизу (lightweight-charts 5): шкала времени общая, у RSI и MACD — свои шкалы цены.
    const main = createChart(mainRef.current, {
      ...base,
      layout: { ...base.layout, panes: { separatorColor: "#26303b", separatorHoverColor: "rgba(200,245,66,.25)", enableResize: true } },
      rightPriceScale: { ...look.rightPriceScale, scaleMargins: { top: 0.06, bottom: 0.2 } },
    });
    const candle = main.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN });
    const vol = main.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const rsiPane = ind.rsi ? 1 : -1;
    const macdPane = ind.macd ? (ind.rsi ? 2 : 1) : -1;
    const rsiLine = rsiPane > 0 ? main.addSeries(LineSeries, {
      color: "#a78bfa", lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: "price", precision: 1, minMove: 0.1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    }, rsiPane) : undefined;
    rsiLine?.createPriceLine({ price: 70, color: "#3a4654", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    rsiLine?.createPriceLine({ price: 30, color: "#3a4654", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    const sub = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const hist = macdPane > 0 ? main.addSeries(HistogramSeries, { ...sub }, macdPane) : undefined;
    const macdLine = macdPane > 0 ? main.addSeries(LineSeries, { ...sub, color: "#1e90ff", lineWidth: 1, lastValueVisible: true }, macdPane) : undefined;
    const sigLine = macdPane > 0 ? main.addSeries(LineSeries, { ...sub, color: "#f5a524", lineWidth: 1 }, macdPane) : undefined;
    main.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
    charts.current = { main };
    series.current = { candle, vol, over: [], rsi: rsiLine, macd: macdLine, sig: sigLine, hist };
    main.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
      if (range && range.from < 5) olderRef.current();
    });
    const onMove = (p: MouseEventParams<Time>) => {
      const d = p.seriesData.get(candle) as { open: number; high: number; low: number; close: number } | undefined;
      const tt = typeof p.time === "number" ? p.time * 1000 : null;
      const v = tt === null ? undefined : barsRef.current.find((b) => b.t === tt);
      setHover(d && v ? v : null);
    };
    main.subscribeCrosshairMove(onMove);
    setGen((g) => g + 1);
    return () => {
      main.remove();
      charts.current = {};
      series.current = { over: [] };
    };
  }, [lang, ind.rsi, ind.macd]);

  // данные и индикаторы
  useEffect(() => {
    const s = series.current;
    const main = charts.current.main;
    if (!s.candle || !main) return;
    const cl = bars.map((b) => b.c);
    const time = (b: Bar) => (b.t / 1000) as UTCTimestamp;
    if (bars.length) s.candle.applyOptions({ priceFormat: tickFormat(bars[bars.length - 1].c) });
    s.candle.setData(bars.map((b) => ({ time: time(b), open: b.o, high: b.h, low: b.l, close: b.c })));
    s.vol?.setData(ind.vol ? bars.map((b) => ({ time: time(b), value: b.v || 0, color: b.c >= b.o ? "rgba(23,201,100,.35)" : "rgba(243,18,96,.35)" })) : []);
    s.over.forEach((x) => main.removeSeries(x));
    s.over = [];
    const add = (vals: Val[], color: string, width: 1 | 2 = 1, style = LineStyle.Solid) => {
      const ser = main.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ser.setData(line(bars, vals));
      s.over.push(ser);
    };
    ind.ema.forEach((n, i) => n > 0 && add(ema(cl, n), EMA_COLORS[i % EMA_COLORS.length], 1));
    if (ind.smaOn && ind.sma > 0) add(sma(cl, ind.sma), "#94a3b8", 1);
    if (ind.vwap) add(vwap(bars), "#22d3ee", 2);
    if (ind.bb) {
      const b = bollinger(cl, 20, 2);
      add(b.up, "#64748b", 1, LineStyle.Dashed);
      add(b.mid, "#64748b", 1, LineStyle.Dotted);
      add(b.low, "#64748b", 1, LineStyle.Dashed);
    }
    s.rsi?.setData(line(bars, rsi(cl, 14)));
    if (s.macd && s.sig && s.hist) {
      const m = macd(cl);
      s.macd.setData(line(bars, m.line));
      s.sig.setData(line(bars, m.signal));
      s.hist.setData(m.hist.flatMap((v, i) => (v === null ? [] : [{ time: time(bars[i]), value: v, color: v >= 0 ? "rgba(23,201,100,.6)" : "rgba(243,18,96,.6)" }])));
    }
  }, [bars, ind, gen]);

  // линии позиции и лимиток
  const priceLines = useRef<IPriceLine[]>([]);
  useEffect(() => {
    const c = series.current.candle;
    if (!c) return;
    priceLines.current.forEach((l) => c.removePriceLine(l));
    priceLines.current = [];
    const pl = (p: number, color: string, title: string, style = LineStyle.Solid) =>
      priceLines.current.push(c.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    myPos.forEach((p) => {
      const pnl = pnlOf(p, book)?.net;
      if (p.entry) pl(p.entry, p.side === "long" ? UP : DOWN, `${p.side} ${p.size}${pnl == null ? "" : ` ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}`);
      if (p.liq && p.liq > 0) pl(p.liq, "#f5a524", "liq", LineStyle.Dotted);
      if (p.tp) pl(p.tp, UP, "TP", LineStyle.LargeDashed);
      if (p.sl) pl(p.sl, DOWN, "SL", LineStyle.LargeDashed);
    });
    myOrders.forEach((o) => o.price && pl(o.price, o.side === "buy" ? UP : DOWN, `${o.side} ${o.size ?? ""}`, LineStyle.Dashed));
  }, [myPos, myOrders, book, gen]);

  // ---------- ордера ----------
  const ok = (demo: boolean, text: string) => oneClick || liveOk(demo, text);
  const market = (side: "buy" | "sell") => {
    if (!key) return;
    if (!ok(key.demo, `${side} ${target.symbol} · ${amount} USDT · market · ${VENUE_LABEL[target.venue]}`)) return;
    send({ type: "place", orderType: "market", keyId: key.id, confirmLive: !key.demo, venue: target.venue, kind: target.kind,
      symbol: target.symbol, side, notional: amount });
  };
  const limit = (side: "buy" | "sell", px: number | undefined, postOnly = false) => {
    if (!key || !px) return;
    if (!ok(key.demo, `${side} ${target.symbol} @ ${fmt(px)} · ${amount} USDT · ${VENUE_LABEL[target.venue]}`)) return;
    send({ type: "place", keyId: key.id, confirmLive: !key.demo, venue: target.venue, kind: target.kind, symbol: target.symbol,
      side, price: px, notional: amount, postOnly });
  };
  const toggleOneClick = () => {
    if (!oneClick && !window.confirm(t("oneClickAsk"))) return;
    sessionStorage.setItem("arb.oneclick", oneClick ? "0" : "1");
    setOneClick(!oneClick);
  };

  // горячие клавиши — только в режиме «в один клик» и не в поле ввода
  const hot = useRef({ market, onClose, pos: myPos[0], oneClick });
  hot.current = { market, onClose, pos: myPos[0], oneClick };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = hot.current;
      if (!h.oneClick || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      // По физической клавише (e.code): работает и в русской раскладке.
      const k = e.code;
      if (k === "KeyB") h.market("buy");
      else if (k === "KeyS") h.market("sell");
      else if (k === "KeyX" && h.pos) h.onClose(h.pos, 1);
      else if (k === "KeyH" && h.pos) h.onClose(h.pos, 0.5);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- выбор монеты ----------
  const findCoin = useCallback((base: string, kind: MarketKind, pickFirst: boolean) => {
    const b = base.trim().toUpperCase();
    if (!b) return;
    fetch(`/api/coin?${new URLSearchParams({ base: b, kind })}`)
      .then((r) => r.json())
      .then((d) => {
        const rows = ((d.rows || []) as { venue: VenueId; symbol: string }[]);
        setVenues(rows);
        if (pickFirst && rows.length) {
          const same = rows.find((r) => r.venue === target.venue) || rows[0];
          onTarget({ venue: same.venue, symbol: same.symbol, kind, base: b });
        }
      })
      .catch(() => {});
  }, [target.venue, onTarget]);
  useEffect(() => findCoin(target.base, target.kind, false), [target.base, target.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = bars[bars.length - 1];
  const rsiNow = useMemo(() => (ind.rsi ? rsi(bars.map((b) => b.c), 14).at(-1) ?? null : null), [bars, ind.rsi]);
  const shown = hover || last;
  const chg = shown && shown.o ? ((shown.c - shown.o) / shown.o) * 100 : null;
  const ladder = useMemo(() => {
    if (!book) return null;
    const base = bookTick(book);
    const tick = base ? base * group : null;
    const r = tickLadder(book, tick, 12, myOrders.flatMap((o) => (o.price ? [o.price] : [])));
    const asks = [...r.asks].reverse();
    const max = Math.max(...asks.map((l) => l.size), ...r.bids.map((l) => l.size), 1e-12);
    return { asks, bids: r.bids, max, tick };
  }, [book, myOrders, group]);
  // TP/SL на позицию; на live — через подтверждение, как и ордера.
  const tpsl = (p: LivePos, leg: "tp" | "sl", px: number | null) => {
    if (!ok(p.demo, `${p.side} ${p.symbol}: ${leg.toUpperCase()} ${px == null ? "×" : fmt(px)}`)) return;
    send({ type: "tpsl", keyId: p.keyId, confirmLive: !p.demo, venue: p.venue, kind: p.kind, symbol: p.symbol, side: p.side,
      ...(px == null ? { clear: leg } : { [leg]: px }) });
  };
  const dragged = useRef<LiveOrder[] | null>(null);
  // Строка лесенки: своя лимитка — подсветка, клик снимает, перетаскивание переносит цену;
  // Shift+клик — TP/SL позиции по этой цене; иначе — новая лимитка.
  const rung = (l: Rung, side: "ask" | "bid") => {
    const mine = ladder ? myOrders.filter((o) => o.price && onRung(l, o.price, ladder.tick, o.side)) : [];
    const pos = myPos[0];
    return (
      <button key={`${side}${l.price}`} type="button" className={`lv ${side}${mine.length ? " mine" : ""}`}
        disabled={!key && !mine.length}
        title={mine.length ? t("cancelHit") : pos ? t("tpslHint") : undefined}
        draggable={mine.length > 0}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", "order");
          dragged.current = mine;
        }}
        onDragEnd={() => (dragged.current = null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const rows = dragged.current;
          dragged.current = null;
          rows?.forEach((o) => o.price !== l.price && onAmend(o, l.price));
        }}
        onClick={(e) => {
          if (mine.length) return mine.forEach(onCancel);
          if (e.shiftKey && pos?.entry) return tpsl(pos, (pos.side === "long") === (l.price > pos.entry) ? "tp" : "sl", l.price);
          limit(side === "ask" ? "sell" : "buy", l.price);
        }}>
        <i style={{ width: `${(l.size / (ladder?.max || 1)) * 100}%` }} />
        <span>{tickText(l.price, ladder?.tick ?? null) ?? fmt(l.price)}</span><span>{mine.length ? `× ${mine.map((o) => o.side).join("/")}` : l.size > 0 ? qty(l.size) : ""}</span>
      </button>
    );
  };
  const setI = (patch: Partial<Ind>) => setInd((v) => ({ ...v, ...patch }));
  const indRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showInd) return;
    const off = (e: MouseEvent) => !indRef.current?.contains(e.target as Node) && setShowInd(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [showInd]);

  return (
    <div className="scalp">
      <div className="scalp-chart">
        <div className="scalp-bar">
          <form
            className="coin-pick"
            onSubmit={(e) => {
              e.preventDefault();
              findCoin(coin, target.kind, true);
            }}
          >
            <input value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} aria-label={t("chCoin")} placeholder="BTC" />
            <button type="submit" className="ghost">{t("chFind")}</button>
          </form>
          <div className="seg">
            {(["perp", "spot"] as MarketKind[]).map((k) => (
              <button key={k} type="button" className={k === target.kind ? "on" : ""} onClick={() => findCoin(target.base, k, true)}>{k}</button>
            ))}
          </div>
          <div className="venue-pick">
            {venues.map((v) => (
              <button key={v.venue} type="button" className={v.venue === target.venue ? "on" : ""}
                onClick={() => onTarget({ venue: v.venue, symbol: v.symbol, kind: target.kind, base: target.base })}>
                <Venue id={v.venue} />
              </button>
            ))}
          </div>
          <div className="grow" />
          <div className="tf-bar">
            {TFS.map((x) => (
              <button key={x} type="button" className={x === tf ? "on" : ""} onClick={() => setTf(x)}>{x}</button>
            ))}
          </div>
          <div className="ind-wrap" ref={indRef}>
            <button type="button" className={`ghost${showInd ? " on" : ""}`} onClick={() => setShowInd((v) => !v)}>ƒ {t("chInd")}</button>
            {showInd && (
              <div className="ind-menu" role="dialog" aria-label={t("chInd")}>
                <label className="ind-row">
                  EMA
                  <input
                    defaultValue={ind.ema.join(", ")}
                    onBlur={(e) => setI({ ema: e.target.value.split(/[ ,;]+/).map(Number).filter((n) => n > 1 && n <= 500).slice(0, 4) })}
                    placeholder="9, 21, 50, 200"
                  />
                </label>
                <label className="ind-row">
                  <input type="checkbox" checked={ind.smaOn} onChange={(e) => setI({ smaOn: e.target.checked })} /> SMA
                  <input type="number" min={2} max={500} value={ind.sma} onChange={(e) => setI({ sma: Number(e.target.value) })} />
                </label>
                <label className="ind-row"><input type="checkbox" checked={ind.vwap} onChange={(e) => setI({ vwap: e.target.checked })} /> VWAP <span className="muted">{t("chVwapDay")}</span></label>
                <label className="ind-row"><input type="checkbox" checked={ind.bb} onChange={(e) => setI({ bb: e.target.checked })} /> Bollinger 20, 2</label>
                <label className="ind-row"><input type="checkbox" checked={ind.vol} onChange={(e) => setI({ vol: e.target.checked })} /> {t("chVolume")}</label>
                <label className="ind-row"><input type="checkbox" checked={ind.rsi} onChange={(e) => setI({ rsi: e.target.checked })} /> RSI 14</label>
                <label className="ind-row"><input type="checkbox" checked={ind.macd} onChange={(e) => setI({ macd: e.target.checked })} /> MACD 12, 26, 9</label>
                <button type="button" className="ghost" onClick={() => setInd(IND0)}>{t("chReset")}</button>
              </div>
            )}
          </div>
        </div>
        <div className="scalp-legend">
          <b><Venue id={target.venue} /> {target.symbol}</b>
          {shown && (
            <span className="ohlc">
              O <i>{fmt(shown.o)}</i> H <i>{fmt(shown.h)}</i> L <i>{fmt(shown.l)}</i> C <i>{fmt(shown.c)}</i>
              {chg !== null && <i className={chg >= 0 ? "pos" : "neg"}> {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</i>}
              {shown.v ? <> V <i>{shown.v.toPrecision(4)}</i></> : null}
            </span>
          )}
          <span className="ema-keys">
            {ind.ema.map((n, i) => <i key={n} style={{ color: EMA_COLORS[i % EMA_COLORS.length] }}>EMA {n}</i>)}
            {ind.vwap && <i style={{ color: "#22d3ee" }}>VWAP</i>}
            {ind.rsi && <i style={{ color: "#a78bfa" }}>RSI 14{rsiNow != null ? ` ${rsiNow.toFixed(1)}` : ""}</i>}
            {ind.macd && <i style={{ color: "#1e90ff" }}>MACD 12, 26, 9</i>}
          </span>
        </div>
        <div className="scalp-main" ref={mainRef}>
          {!bars.length && <span className="muted chart-wait">{t("chLoading")}</span>}
        </div>
      </div>

      <aside className="scalp-side">
        <section className="ticket">
          <div className="ticket-head">
            {myKeys.length > 1 ? (
              <select value={key?.id} onChange={(e) => setKeyId(e.target.value)} aria-label={t("chKey")}>
                {myKeys.map((k) => <option key={k.id} value={k.id}>{k.demo ? "demo" : "LIVE"} · {k.id}</option>)}
              </select>
            ) : key ? (
              <b className={key.demo ? "muted" : "neg"}>{key.demo ? "demo" : "LIVE"} · {VENUE_LABEL[target.venue]}</b>
            ) : (
              <span className="muted">{t("chNoKey", { venue: VENUE_LABEL[target.venue] })}</span>
            )}
            <button type="button" className={`mini${sound ? " on" : ""}`} title={t(sound ? "soundOn" : "soundOff")} onClick={() => onSound(!sound)}>
              {sound ? "🔔" : "🔕"}
            </button>
            <label className={`one-click${oneClick ? " on" : ""}`} title={t("oneClickHint")}>
              <input type="checkbox" checked={oneClick} onChange={toggleOneClick} /> {t("oneClick")}
            </label>
          </div>
          <div className="amount">
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} aria-label={t("chAmount")} />
            <span className="muted">USDT</span>
          </div>
          <div className="chips">
            {QUOTE_CHIPS.map((q) => (
              <button key={q} type="button" className={q === amount ? "on" : ""} onClick={() => setAmount(q)}>{q}</button>
            ))}
          </div>
          <div className="mkt">
            <button type="button" className="big buy" disabled={!key} onClick={() => market("buy")}>
              {t("chBuyMkt")}<small>{bestAsk ? fmt(bestAsk) : "—"}</small>
            </button>
            <button type="button" className="big sell" disabled={!key} onClick={() => market("sell")}>
              {t("chSellMkt")}<small>{bestBid ? fmt(bestBid) : "—"}</small>
            </button>
          </div>
          <div className="mkt">
            <button type="button" className="ghost" disabled={!key || !bestBid} title={t("chMakerHint")} onClick={() => limit("buy", bestBid, true)}>{t("chBuyBid")}</button>
            <button type="button" className="ghost" disabled={!key || !bestAsk} title={t("chMakerHint")} onClick={() => limit("sell", bestAsk, true)}>{t("chSellAsk")}</button>
          </div>
          {oneClick && <p className="hot-hint">{t("chHotkeys")}</p>}
        </section>

        {myPos.map((p) => {
          const busy = closing.has(`pos:${p.keyId}|${p.symbol}|${p.side}`);
          const exitPx = p.side === "long" ? bestAsk : bestBid;
          return (
            <section key={`${p.keyId}|${p.side}`} className={`pos-card ${p.side === "long" ? "long" : "short"}`}>
              <div className="pos-top">
                <b className={p.side === "long" ? "pos" : "neg"}>{p.side}</b>
                <span>{p.size}</span>
                {p.entry != null && <span className="muted">@ {fmt(p.entry)}</span>}
                <PnlText row={p} book={book} />
              </div>
              {p.liq && p.liq > 0 ? <div className="muted">liq {fmt(p.liq)}{p.leverage ? ` · ${p.leverage}x` : ""}</div> : null}
              <div className="pos-close">
                {[0.25, 0.5, 0.75, 1].map((f) => (
                  <button key={f} type="button" className={`mini${f === 1 ? " sell" : ""}`} disabled={busy} onClick={() => onClose(p, f)}>
                    {busy ? "…" : f === 1 ? t("chCloseAll") : `${f * 100}%`}
                  </button>
                ))}
              </div>
              <button type="button" className="ghost wide" disabled={busy || !exitPx} title={t("chCloseLimitHint")} onClick={() => onClose(p, 1, exitPx)}>
                {t("chCloseLimit")} {exitPx ? fmt(exitPx) : ""}
              </button>
              {p.kind === "perp" && <TpSl p={p} onSet={(leg, px) => tpsl(p, leg, px)} onClear={(leg) => tpsl(p, leg, null)} />}
            </section>
          );
        })}

        {myOrders.length > 0 && (
          <section className="ord-list">
            <div className="ord-head">
              <span className="muted">{t("blotOrders")}</span>
              {myOrders.length > 1 && <button type="button" className="mini" onClick={() => myOrders.forEach(onCancel)}>{t("chCancelAll")}</button>}
            </div>
            {myOrders.map((o) => (
              <div key={o.id} className="blot-row">
                <span className={o.side === "buy" ? "pos" : "neg"}>{o.side}</span>
                <span>{o.size ?? ""}</span>
                <span>@ {o.price ? fmt(o.price) : "mkt"}</span>
                <button type="button" className="mini sell" onClick={() => onCancel(o)}>×</button>
              </div>
            ))}
          </section>
        )}

        <section className="ladder-mini" title={t("chLadderHint")}>
          {!ladder && <span className="muted">{t("chLoading")}</span>}
          {ladder?.asks.map((l) => rung(l, "ask"))}
          {ladder && bestBid && bestAsk && (
            <div className="lv mid"><GroupPick value={group} onChange={onGroup} /> {t("chSpread")} {fmt(bestAsk - bestBid)} · {(((bestAsk - bestBid) / bestBid) * 100).toFixed(4)}%</div>
          )}
          {ladder?.bids.map((l) => rung(l, "bid"))}
        </section>
      </aside>
    </div>
  );
}
