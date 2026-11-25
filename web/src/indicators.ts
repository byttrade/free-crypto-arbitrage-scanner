// Индикаторы для графика монеты. Чистые функции: свечи → значения по тем же временам (null, пока данных мало).

export type Bar = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type Val = number | null;

export function sma(xs: number[], n: number): Val[] {
  const out: Val[] = [];
  let sum = 0;
  xs.forEach((x, i) => {
    sum += x;
    if (i >= n) sum -= xs[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  });
  return out;
}

export function ema(xs: number[], n: number): Val[] {
  // Старт — SMA первых n значений, как в TradingView.
  const out: Val[] = [];
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let sum = 0;
  xs.forEach((x, i) => {
    if (prev === null) {
      sum += x;
      if (i === n - 1) prev = sum / n;
      out.push(prev);
      return;
    }
    prev = x * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

export function bollinger(xs: number[], n = 20, mult = 2) {
  const mid = sma(xs, n);
  const up: Val[] = [];
  const low: Val[] = [];
  mid.forEach((m, i) => {
    if (m === null) {
      up.push(null);
      low.push(null);
      return;
    }
    let d = 0;
    for (let j = i - n + 1; j <= i; j++) d += (xs[j] - m) ** 2;
    const sd = Math.sqrt(d / n);
    up.push(m + mult * sd);
    low.push(m - mult * sd);
  });
  return { mid, up, low };
}

/** VWAP с обнулением в 00:00 UTC (дневная сессия крипты). Без объёма — null. */
export function vwap(bars: Bar[]): Val[] {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const d = Math.floor(b.t / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const v = b.v || 0;
    pv += ((b.h + b.l + b.c) / 3) * v;
    vol += v;
    return vol > 0 ? pv / vol : null;
  });
}

/** RSI по Уайлдеру. */
export function rsi(xs: number[], n = 14): Val[] {
  const out: Val[] = [null];
  let up = 0;
  let down = 0;
  for (let i = 1; i < xs.length; i++) {
    const ch = xs[i] - xs[i - 1];
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    if (i <= n) {
      up += g / n;
      down += l / n;
      out.push(i === n ? (down === 0 ? 100 : 100 - 100 / (1 + up / down)) : null);
      continue;
    }
    up = (up * (n - 1) + g) / n;
    down = (down * (n - 1) + l) / n;
    out.push(down === 0 ? 100 : 100 - 100 / (1 + up / down));
  }
  return xs.length ? out : [];
}

export function macd(xs: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(xs, fast);
  const s = ema(xs, slow);
  const line: Val[] = xs.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  const start = line.findIndex((x) => x !== null);
  const sig: Val[] = line.map(() => null);
  if (start >= 0) {
    ema(line.slice(start) as number[], signal).forEach((x, j) => (sig[start + j] = x));
  }
  const hist: Val[] = line.map((x, i) => (x === null || sig[i] === null ? null : x - sig[i]!));
  return { line, signal: sig, hist };
}

/** Живая свеча: сделка из ленты обновляет последнюю свечу или открывает новую. */
export function applyTrade(bars: Bar[], tfMs: number, ts: number, price: number, size: number): Bar[] {
  const start = Math.floor(ts / tfMs) * tfMs;
  const last = bars[bars.length - 1];
  if (!last || start < last.t) return bars; // старая сделка — история уже учла
  if (start === last.t) {
    const next = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, v: (last.v || 0) + size };
    return [...bars.slice(0, -1), next];
  }
  return [...bars, { t: start, o: price, h: price, l: price, c: price, v: size }];
}

/** Свежие свечи с биржи поверх истории: совпадающие времена заменяем, новые добавляем. */
export function mergeLatest(bars: Bar[], fresh: Bar[]): Bar[] {
  if (!fresh.length) return bars;
  const from = fresh[0].t;
  return [...bars.filter((b) => b.t < from), ...fresh];
}
