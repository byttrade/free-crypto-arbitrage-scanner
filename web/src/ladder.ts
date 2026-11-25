// Стакан на сетке тика и живой PnL. Чистые функции — проверяются tests/ladder.check.ts.

type Level = { price: number; size: number };
type Book = { venue?: string; symbol?: string; bids: Level[]; asks: Level[]; tick?: number | null };
export type Rung = { price: number; size: number; i: number };

// Шаг, однажды найденный для рынка, — чтобы сетка не пересчитывалась на каждом апдейте.
const memo = new Map<string, number>();

/** Шаг цены: с сервера; иначе один раз оценка по минимальной дыре между уровнями. */
export function bookTick(book: Book): number | null {
  const key = `${book.venue}|${book.symbol}`;
  const ref = book.asks[0]?.price || book.bids[0]?.price || 0;
  if (book.tick && book.tick > 0 && (!ref || book.tick < ref)) {
    memo.set(key, book.tick);
    return book.tick;
  }
  const known = memo.get(key);
  if (known) return known;
  let gap = Infinity;
  for (const side of [book.asks, book.bids]) {
    for (let j = 1; j < side.length; j++) {
      const d = Math.abs(side[j].price - side[j - 1].price);
      if (d > 0 && d < gap) gap = d;
    }
  }
  if (!Number.isFinite(gap)) return null;
  const step = Number(gap.toPrecision(6));
  memo.set(key, step);
  return step;
}

/** Сколько знаков после запятой у шага: 0.25 → 2, 5e-5 → 5. */
export function decimals(step: number): number {
  const [m, e] = step.toExponential().split("e");
  return Math.min(20, Math.max(0, (m.split(".")[1] || "").length - Number(e)));
}

/** Цена с точностью шага: соседние тики не должны выглядеть одинаково. Без шага — null (формат по умолчанию). */
export function tickText(n: number, tick: number | null): string | null {
  if (!tick) return null;
  const d = decimals(tick);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const KEEP_MAX = 200; // на сколько тиков сетка может вырасти ради своей дальней лимитки

/** n тиков вверх от лучшего ask и n вниз от лучшего bid; пустой тик — строка с нулевым объёмом.
 *  keep — цены своих ордеров: сетка растягивается, чтобы они были видны (не больше KEEP_MAX тиков сверх n). */
export function tickLadder(book: Book, tick: number | null, n: number, keep: number[] = []): { asks: Rung[]; bids: Rung[] } {
  if (!tick) {
    const raw = (side: Level[]) => side.slice(0, n).map((l) => ({ ...l, i: NaN }));
    return { asks: raw(book.asks), bids: raw(book.bids) };
  }
  const dec = decimals(tick);
  const fill = (side: Level[], dir: 1 | -1): Rung[] => {
    if (!side.length) return [];
    const sizes = new Map<number, number>();
    for (const l of side) {
      const i = Math.round(l.price / tick);
      sizes.set(i, (sizes.get(i) || 0) + l.size);
    }
    const start = Math.round(side[0].price / tick);
    const reach = keep.reduce((m, px) => Math.max(m, (Math.round(px / tick) - start) * dir + 1), n);
    return Array.from({ length: Math.min(reach, n + KEEP_MAX) }, (_, k) => {
      const i = start + dir * k;
      return { i, price: Number((i * tick).toFixed(dec)), size: sizes.get(i) || 0 };
    });
  };
  return { asks: fill(book.asks, 1), bids: fill(book.bids, -1) };
}

/** Ордер на строке: тот же тик (или та же цена, когда сетки нет). */
export function onRung(r: Rung, px: number, tick: number | null): boolean {
  return tick ? Math.round(px / tick) === r.i : Math.abs(px - r.price) <= r.price * 1e-9;
}

/** PnL по стакану: лонг закрывается по bid, шорт по ask; в валюте котировки. */
export function livePnl(
  p: { side: string | null; size: number; entry: number | null },
  book: { bids: Level[]; asks: Level[] } | null | undefined,
): number | null {
  if (!book || p.entry == null || !p.size) return null;
  if (p.side === "long") {
    const bid = book.bids[0]?.price;
    return bid ? (bid - p.entry) * p.size : null;
  }
  if (p.side === "short") {
    const ask = book.asks[0]?.price;
    return ask ? (p.entry - ask) * p.size : null;
  }
  return null;
}
