import { createChart, LineStyle, TickMarkType, type AutoscaleInfo, type IChartApi, type ISeriesApi, type LogicalRange, type Time, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n, type Lang } from "./i18n";

function histMark(time: Time, lang: Lang) {
  if (typeof time !== "number") return "";
  const d = new Date(time * 1000);
  const loc = lang === "ru" ? "ru-RU" : "en-GB";
  const date = d.toLocaleDateString(loc, { day: "2-digit", month: "short" });
  const hm = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${hm}`;
}

export function SpreadChart({
  points,
  ema = true,
  onOlder,
}: {
  points: { ts: number; z: number }[] | null;
  ema?: boolean;
  onOlder?: () => void;
}) {
  const { lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Line"> | null>(null);
  const avg = useRef<ISeriesApi<"Line"> | null>(null);
  const seen = useRef(0);
  const ask = useRef(onOlder);
  ask.current = onOlder;
  const [range, setRange] = useState("");

  useEffect(() => {
    if (!ref.current) return;
    seen.current = 0;
    const c = createChart(ref.current, {
      layout: { background: { color: "#07090c" }, textColor: "#8b96a5", fontSize: 11 },
      grid: { vertLines: { color: "#151b22" }, horzLines: { color: "#151b22" } },
      rightPriceScale: { borderColor: "#242c36" },
      timeScale: {
        borderColor: "#242c36",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => tickMark(time, type, lang),
      },
      localization: { timeFormatter: (time: Time) => histMark(time, lang) },
      autoSize: true,
    });
    const s = c.addLineSeries({ color: "#c8f542", lineWidth: 2, priceLineVisible: false });
    s.createPriceLine({ price: 0, color: "#9aa89a", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
    const m = c.addLineSeries({ color: "#e2b340", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    chart.current = c;
    series.current = s;
    avg.current = m;
    const onRange = (span: LogicalRange | null) => {
      if (ask.current && seen.current > 0 && span && span.from < -0.5) ask.current();
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      avg.current = null;
      seen.current = 0;
    };
  }, [lang]);

  useEffect(() => {
    const c = chart.current;
    const s = series.current;
    if (!c || !s) return;
    const data = (points || []).map((p) => ({
      time: Math.floor(p.ts / 1000) as UTCTimestamp,
      value: p.z,
    }));
    const before = c.timeScale().getVisibleLogicalRange();
    const prev = seen.current;
    s.setData(data);
    avg.current?.setData(ema ? emaLine(data, EMA) : []);
    if (!data.length) {
      seen.current = 0;
      setRange("");
      return;
    }
    const added = data.length - prev;
    if (!prev || added < 0) c.timeScale().fitContent();
    else if (before && added > 0) {
      const reveal = before.from < 5 ? Math.min(added, 40) : 0;
      c.timeScale().setVisibleLogicalRange({
        from: before.from + added - reveal,
        to: before.to + added - reveal,
      });
    } else if (before) c.timeScale().setVisibleLogicalRange(before);
    seen.current = data.length;
    const show = () => {
      const span = c.timeScale().getVisibleRange();
      if (!span || typeof span.from !== "number" || typeof span.to !== "number") return;
      setRange(`${histMark(span.from, lang)} – ${histMark(span.to, lang)}`);
    };
    c.timeScale().subscribeVisibleTimeRangeChange(show);
    show();
    return () => c.timeScale().unsubscribeVisibleTimeRangeChange(show);
  }, [points, lang, ema]);

  return (
    <div className="chart cv-wrap">
      <div className="cv" ref={ref} />
      {range && <i className="cv-range">{range}</i>}
    </div>
  );
}

type Bar = { t: number; o: number; h: number; l: number; c: number };
type LinePoint = { time: UTCTimestamp; value: number };
type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

const PAGE = 200;
const FIRST = 500;
const EMA = 200;

function emaLine(points: LinePoint[], period: number): LinePoint[] {
  if (points.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += points[i].value;
  let prev = sum / period;
  const out: LinePoint[] = [{ time: points[period - 1].time, value: prev }];
  for (let i = period; i < points.length; i++) {
    prev = points[i].value * k + prev * (1 - k);
    out.push({ time: points[i].time, value: prev });
  }
  return out;
}
type Tf = "5m" | "1h" | "4h" | "1d";
const TFS: Tf[] = ["5m", "1h", "4h", "1d"];
const TF_MS: Record<Tf, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const TF_NAME: Record<Lang, Record<Tf, string>> = {
  en: { "5m": "5m", "1h": "1h", "4h": "4h", "1d": "1d" },
  ru: { "5m": "5м", "1h": "1ч", "4h": "4ч", "1d": "1д" },
};

function spanText(from: number, to: number, tf: Tf, lang: Lang) {
  const loc = lang === "ru" ? "ru-RU" : "en-GB";
  const day: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short" };
  const clock: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const one = (sec: number) => {
    const d = new Date(sec * 1000);
    const date = d.toLocaleDateString(loc, day);
    if (tf === "1d") return date;
    return `${date} ${d.toLocaleTimeString(loc, clock)}`;
  };
  return `${one(from)} – ${one(to)}`;
}

function tickMark(time: Time, type: TickMarkType, lang: Lang) {
  if (typeof time !== "number") return "";
  const loc = lang === "ru" ? "ru-RU" : "en-GB";
  const d = new Date(time * 1000);
  const date = d.toLocaleDateString(loc, { day: "2-digit", month: "short" });
  if (type < TickMarkType.Time) return date;
  // Метки оси короткие, иначе на узких графиках «24 Nov 15:00» налезают друг на друга; полная дата — в перекрестье.
  return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
}

function chartText(lang: Lang) {
  return {
    localization: {
      locale: lang === "ru" ? "ru-RU" : "en-GB",
      timeFormatter: (time: Time) => histMark(time, lang),
    },
    timeScale: {
      ...look.timeScale,
      tickMarkFormatter: (time: Time, type: TickMarkType) => tickMark(time, type, lang),
    },
  };
}

const look = {
  layout: {
    background: { color: "#111113" },
    textColor: "#c5ced6",
    fontSize: 11,
    fontFamily: "IBM Plex Mono, ui-monospace, monospace",
  },
  grid: { vertLines: { visible: false }, horzLines: { color: "#1c232b" } },
  rightPriceScale: { borderVisible: false, minimumWidth: 84, scaleMargins: { top: 0.14, bottom: 0.14 } },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  crosshair: {
    vertLine: { color: "#3a4654", labelVisible: true, labelBackgroundColor: "#161c24" },
    horzLine: { color: "#3a4654", labelVisible: true, labelBackgroundColor: "#161c24" },
  },
  autoSize: true,
};

function tickFormat(sample: number) {
  const abs = Math.abs(sample);
  const precision = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return { type: "price" as const, precision, minMove: 10 ** -precision };
}

function useChart(ref: RefObject<HTMLDivElement | null>, lang: Lang) {
  const chart = useRef<IChartApi | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  useEffect(() => {
    if (!ref.current) return;
    const c = createChart(ref.current, { ...look, ...chartText(langRef.current) });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, [ref]);
  useEffect(() => {
    chart.current?.applyOptions(chartText(lang));
  }, [lang]);
  return chart;
}

function useSpan(chart: RefObject<IChartApi | null>, tf: Tf, lang: Lang) {
  const [text, setText] = useState("");
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const paint = () => {
      const range = c.timeScale().getVisibleRange();
      if (!range || typeof range.from !== "number" || typeof range.to !== "number") return;
      setText(spanText(range.from, range.to, tf, lang));
    };
    c.timeScale().subscribeVisibleTimeRangeChange(paint);
    paint();
    return () => c.timeScale().unsubscribeVisibleTimeRangeChange(paint);
  }, [chart, tf, lang]);
  return text;
}

function useOlder(chart: RefObject<IChartApi | null>, onOlder: () => void) {
  const ask = useRef(onOlder);
  ask.current = onOlder;
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const onRange = (range: LogicalRange | null) => {
      if (range && range.from < 30) ask.current();
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [chart]);
}

function showTail(chart: IChartApi, count: number) {
  const width = chart.timeScale().width();
  const spacing = Math.max(0.5, (width > 0 ? width : 160) / 80);
  chart.timeScale().applyOptions({ barSpacing: spacing, rightOffset: 1 });
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, count - 80), to: count + 1 });
}

function shiftView(chart: IChartApi, seen: { n: number }, count: number, before: { from: number; to: number } | null) {
  const added = count - seen.n;
  if (!seen.n) showTail(chart, count);
  else if (before && added > 0) {
    const reveal = before.from < 30 ? Math.min(added, 40) : 0;
    chart.timeScale().setVisibleLogicalRange({
      from: before.from + added - reveal,
      to: before.to + added - reveal,
    });
  }
  seen.n = count;
}

function spreadLine(buy: Bar[], sell: Bar[], step: number) {
  const bucket = (t: number) => Math.floor(t / step) * step;
  const other = new Map(sell.map((b) => [bucket(b.t), b.c]));
  const seen = new Set<number>();
  const out: LinePoint[] = [];
  for (const b of [...buy].sort((a, c) => a.t - c.t)) {
    const close = other.get(bucket(b.t));
    const time = Math.floor(b.t / 1000) as UTCTimestamp;
    if (close == null || b.c <= 0 || seen.has(time)) continue;
    seen.add(time);
    out.push({ time, value: ((close - b.c) / b.c) * 100 });
  }
  return out;
}

function candlesOf(rows: Bar[]) {
  const seen = new Set<number>();
  return [...rows]
    .sort((a, b) => a.t - b.t)
    .flatMap((b) => {
      const time = Math.floor(b.t / 1000) as UTCTimestamp;
      if (seen.has(time)) return [];
      seen.add(time);
      return [{ time, open: b.o, high: b.h, low: b.l, close: b.c }];
    });
}

function mergeBars(prev: Bar[], extra: Bar[]) {
  if (!extra.length) return prev;
  const seen = new Set(prev.map((b) => b.t));
  const add = extra.filter((b) => !seen.has(b.t));
  if (!add.length) return prev;
  return [...add, ...prev].sort((a, b) => a.t - b.t);
}

export function MiniCharts({
  id,
  kind,
  buyVenue,
  sellVenue,
  buySymbol,
  sellSymbol,
  buyTitle,
  sellTitle,
  spreadTitle,
  initialTf = "5m",
}: {
  id: string;
  kind: string;
  buyVenue: string;
  sellVenue: string;
  buySymbol: string;
  sellSymbol: string;
  buyTitle: string;
  sellTitle: string;
  spreadTitle: string;
  initialTf?: Tf;
}) {
  const { t, lang } = useI18n();
  const [tf, setTf] = useState<Tf>(initialTf);
  const [emaOn, setEmaOn] = useState(true);
  const [buy, setBuy] = useState<Bar[]>([]);
  const [sell, setSell] = useState<Bar[]>([]);
  const [open, setOpen] = useState<"spread" | "buy" | "sell" | null>(null);
  const [pair, setPair] = useState(id);
  const buyRef = useRef<Bar[]>([]);
  const sellRef = useRef<Bar[]>([]);
  const lock = useRef(false);
  const end = useRef(false);
  if (pair !== id) {
    setPair(id);
    setBuy([]);
    setSell([]);
    setOpen(null);
    end.current = false;
  }
  buyRef.current = buy;
  sellRef.current = sell;

  const load = useCallback((venue: string, symbol: string, since?: number, until?: number, limit = PAGE) => {
    const q = new URLSearchParams({ venue, symbol, kind, tf, limit: String(limit) });
    if (since) q.set("since", String(since));
    if (until) q.set("until", String(until));
    return fetch(`/api/candles?${q}`).then((r) => r.json()).then((d) => (d.candles || []) as Bar[]);
  }, [kind, tf]);

  useEffect(() => {
    let stop = false;
    end.current = false;
    setOpen(null);
    setBuy([]);
    setSell([]);
    Promise.all([
      load(buyVenue, buySymbol, undefined, undefined, FIRST),
      load(sellVenue, sellSymbol, undefined, undefined, FIRST),
    ])
      .then(([a, b]) => {
        if (!stop) {
          setBuy(a);
          setSell(b);
        }
      })
      .catch(() => {
        if (!stop) {
          setBuy([]);
          setSell([]);
        }
      });
    return () => {
      stop = true;
    };
  }, [id, load, buyVenue, sellVenue, buySymbol, sellSymbol]);

  const askOlder = useCallback(() => {
    if (lock.current || end.current) return;
    const buyOld = buyRef.current[0]?.t;
    const sellOld = sellRef.current[0]?.t;
    if (!buyOld && !sellOld) return;
    lock.current = true;
    const page = (venue: string, symbol: string, ts: number) => load(venue, symbol, ts - PAGE * TF_MS[tf], ts - 1);
    Promise.all([
      buyOld ? page(buyVenue, buySymbol, buyOld) : Promise.resolve([] as Bar[]),
      sellOld ? page(sellVenue, sellSymbol, sellOld) : Promise.resolve([] as Bar[]),
    ])
      .then(([a, b]) => {
        const nextBuy = mergeBars(buyRef.current, a);
        const nextSell = mergeBars(sellRef.current, b);
        if (nextBuy.length === buyRef.current.length && nextSell.length === sellRef.current.length) {
          end.current = true;
          return;
        }
        setBuy(nextBuy);
        setSell(nextSell);
      })
      .catch(() => {})
      .finally(() => {
        lock.current = false;
      });
  }, [load, buyVenue, sellVenue, buySymbol, sellSymbol, tf]);

  const spread = useMemo(
    () => spreadLine(buy, sell, TF_MS[tf]),
    [buy, sell, tf],
  );
  const buyBars = useMemo(() => candlesOf(buy), [buy]);
  const sellBars = useMemo(() => candlesOf(sell), [sell]);
  const spreadName = `${spreadTitle} ${TF_NAME[lang][tf]}`;
  const titles = { spread: spreadName, buy: buyTitle, sell: sellTitle };
  const key = `${id}:${tf}`;

  return (
    <div className="minis-stack">
      <div className="tf-bar">
        {TFS.map((item) => (
          <button key={item} type="button" className={item === tf ? "on" : ""} onClick={() => setTf(item)}>
            {TF_NAME[lang][item]}
          </button>
        ))}
        <button type="button" className={`ema${emaOn ? " on" : ""}`} aria-pressed={emaOn} onClick={() => setEmaOn((v) => !v)}>
          EMA {EMA}
        </button>
      </div>
      <div className="minis">
        <Pane title={spreadName} expandLabel={t("expandChart")} onExpand={() => setOpen("spread")}>
          <LinePane points={spread} resetKey={key} tf={tf} ema={emaOn} onOlder={askOlder} />
        </Pane>
        <Pane title={buyTitle} expandLabel={t("expandChart")} onExpand={() => setOpen("buy")}>
          <CandlePane bars={buyBars} resetKey={key} tf={tf} onOlder={askOlder} />
        </Pane>
        <Pane title={sellTitle} expandLabel={t("expandChart")} onExpand={() => setOpen("sell")}>
          <CandlePane bars={sellBars} resetKey={key} tf={tf} onOlder={askOlder} />
        </Pane>
      </div>
      {open && createPortal(
        <ChartModal title={titles[open]} closeLabel={t("closeChart")} onClose={() => setOpen(null)}>
          {open === "spread" && <LinePane points={spread} resetKey={key} tf={tf} ema={emaOn} onOlder={askOlder} />}
          {open === "buy" && <CandlePane bars={buyBars} resetKey={key} tf={tf} onOlder={askOlder} />}
          {open === "sell" && <CandlePane bars={sellBars} resetKey={key} tf={tf} onOlder={askOlder} />}
        </ChartModal>,
        document.body,
      )}
    </div>
  );
}

function Pane({
  title,
  expandLabel,
  onExpand,
  children,
}: {
  title: string;
  expandLabel: string;
  onExpand: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mini-chart">
      <div className="mini-head">
        <b>{title}</b>
        <button type="button" title={expandLabel} aria-label={expandLabel} onClick={onExpand}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
      {children}
    </div>
  );
}

function ChartModal({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [on, setOn] = useState(false);
  const closeTo = useRef(onClose);
  const closing = useRef(false);
  const timer = useRef(0);
  closeTo.current = onClose;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true));
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer.current);
    };
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setOn(false);
    const wait = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    timer.current = window.setTimeout(() => closeTo.current(), wait);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`chart-pop${on ? " on" : ""}`} onMouseDown={close}>
      <div className="chart-box" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header>
          <b>{title}</b>
          <button type="button" onClick={close} aria-label={closeLabel}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function LinePane({ points, resetKey, tf, ema, onOlder }: { points: LinePoint[]; resetKey: string; tf: Tf; ema: boolean; onOlder: () => void }) {
  const { lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useChart(ref, lang);
  const when = useSpan(chart, tf, lang);
  const series = useRef<ISeriesApi<"Baseline"> | null>(null);
  const avg = useRef<ISeriesApi<"Line"> | null>(null);
  const seen = useRef({ key: "", n: 0 });
  useOlder(chart, onOlder);

  useEffect(() => {
    if (!chart.current || series.current) return;
    const s = chart.current.addBaselineSeries({
      baseValue: { type: "price", price: 0 },
      topLineColor: "#0077ff",
      bottomLineColor: "#0077ff",
      topFillColor1: "rgba(23, 201, 100, 0.22)",
      topFillColor2: "rgba(23, 201, 100, 0.08)",
      bottomFillColor1: "rgba(23, 201, 100, 0)",
      bottomFillColor2: "rgba(23, 201, 100, 0)",
      lineWidth: 2,
      priceLineVisible: false,
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = base();
        if (!info) return null;
        const min = Math.min(info.priceRange.minValue, 0);
        const max = Math.max(info.priceRange.maxValue, 0);
        const pad = Math.max((max - min) * 0.12, 0.4);
        return { priceRange: { minValue: min - pad, maxValue: max + pad * 0.15 } };
      },
    });
    s.createPriceLine({
      price: 0,
      color: "#9aa89a",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });
    series.current = s;
    avg.current = chart.current.addLineSeries({
      color: "#e2b340",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
  }, [chart]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    if (seen.current.key !== resetKey) seen.current = { key: resetKey, n: 0 };
    const sample = points.reduce((max, p) => Math.max(max, Math.abs(p.value)), 0);
    series.current.applyOptions({ priceFormat: tickFormat(sample || 1) });
    const before = chart.current.timeScale().getVisibleLogicalRange();
    const first = seen.current.n === 0;
    series.current.setData(points);
    avg.current?.applyOptions({ priceFormat: tickFormat(sample || 1) });
    avg.current?.setData(ema ? emaLine(points, EMA) : []);
    if (!points.length) {
      seen.current.n = 0;
      return;
    }
    if (first || seen.current.n !== points.length) shiftView(chart.current, seen.current, points.length, before);
    else if (before) chart.current.timeScale().setVisibleLogicalRange(before);
    const c = chart.current;
    const count = points.length;
    let alive = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!alive) return;
      c.applyOptions({});
      if (first) showTail(c, count);
    }));
    return () => {
      alive = false;
    };
  }, [chart, points, resetKey, ema]);

  return (
    <div className="cv-wrap">
      <div className="cv" ref={ref} />
      {when && <i className="cv-range">{when}</i>}
    </div>
  );
}

function CandlePane({ bars, resetKey, tf, onOlder }: { bars: Candle[]; resetKey: string; tf: Tf; onOlder: () => void }) {
  const { lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useChart(ref, lang);
  const when = useSpan(chart, tf, lang);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const seen = useRef({ key: "", n: 0 });
  useOlder(chart, onOlder);

  useEffect(() => {
    if (!chart.current || series.current) return;
    series.current = chart.current.addCandlestickSeries({
      upColor: "#17c964",
      downColor: "#f31260",
      borderVisible: false,
      wickUpColor: "#17c964",
      wickDownColor: "#f31260",
      priceLineVisible: false,
    });
  }, [chart]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    if (seen.current.key !== resetKey) seen.current = { key: resetKey, n: 0 };
    const sample = bars.at(-1)?.close ?? 0;
    series.current.applyOptions({ priceFormat: tickFormat(sample || 1) });
    const before = chart.current.timeScale().getVisibleLogicalRange();
    series.current.setData(bars);
    if (!bars.length) {
      seen.current.n = 0;
      return;
    }
    shiftView(chart.current, seen.current, bars.length, before);
  }, [chart, bars, resetKey]);

  return (
    <div className="cv-wrap">
      <div className="cv" ref={ref} />
      {when && <i className="cv-range">{when}</i>}
    </div>
  );
}
