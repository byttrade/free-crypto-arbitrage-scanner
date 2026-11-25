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

const KEEP_MAX = 200;
const EPS = 1e-7;
/** Номер строки сетки: ask и продажа — вверх, bid и покупка — вниз (при группировке тиков, как в DOM). */
const slot = (px: number, step: number, up: boolean) => (up ? Math.ceil(px / step - EPS) : Math.floor(px / step + EPS)); // на сколько тиков сетка может вырасти ради своей дальней лимитки

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
      const i = slot(l.price, tick, dir === 1);
      sizes.set(i, (sizes.get(i) || 0) + l.size);
    }
    const start = slot(side[0].price, tick, dir === 1);
    const reach = keep.reduce((m, px) => Math.max(m, (slot(px, tick, dir === 1) - start) * dir + 1), n);
    return Array.from({ length: Math.min(reach, n + KEEP_MAX) }, (_, k) => {
      const i = start + dir * k;
      return { i, price: Number((i * tick).toFixed(dec)), size: sizes.get(i) || 0 };
    });
  };
  return { asks: fill(book.asks, 1), bids: fill(book.bids, -1) };
}

/** Ордер на строке: та же ячейка сетки (продажа — вверх, покупка — вниз) или та же цена, когда сетки нет. */
export function onRung(r: Rung, px: number, tick: number | null, side: string = "buy"): boolean {
  return tick ? slot(px, tick, side === "sell") === r.i : Math.abs(px - r.price) <= r.price * 1e-9;
}

export type Pnl = { net: number; gross: number; fee: number; px: number };

/** PnL позиции в валюте котировки, за вычетом taker на вход и выход.
 *  Цена выхода: лонг — лучший bid, шорт — лучший ask. На demo стакан — живого рынка, а цены у demo свои:
 *  там берём цену маркировки с биржи (её нет — PnL биржи). */
export function pnlOf(
  p: { side: string | null; size: number; entry: number | null; demo?: boolean; mark?: number | null; pnl?: number | null; taker?: number | null },
  book: { bids: Level[]; asks: Level[] } | null | undefined,
): Pnl | null {
  if (p.entry == null || !p.size || (p.side !== "long" && p.side !== "short")) return null;
  const top = p.side === "long" ? book?.bids[0]?.price : book?.asks[0]?.price;
  const px = p.demo ? p.mark || null : top || p.mark || null;
  const dir = p.side === "long" ? 1 : -1;
  const gross = px ? (px - p.entry) * p.size * dir : p.pnl;
  if (gross == null) return null;
  const exit = px || p.entry;
  const fee = (p.taker || 0) * p.size * (p.entry + exit);
  return { net: gross - fee, gross, fee, px: exit };
}
