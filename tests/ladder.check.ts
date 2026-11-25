// Самопроверка сетки стакана и живого PnL: node tests/ladder.check.ts (запускает и pytest).
import assert from "node:assert/strict";
import { bookTick, decimals, livePnl, onRung, tickLadder, tickText } from "../web/src/ladder.ts";

assert.equal(decimals(0.25), 2);
assert.equal(decimals(5e-5), 5);
assert.equal(decimals(1e-7), 7);
assert.equal(decimals(10), 0);

// Сетка: дыры остаются строками, уровни внутри тика суммируются, цены без хвостов плавающей точки.
const book = { venue: "x", symbol: "A", tick: 0.1,
  asks: [{ price: 1.2, size: 1 }, { price: 1.5, size: 2 }, { price: 1.51, size: 3 }],
  bids: [{ price: 1.1, size: 4 }, { price: 0.8, size: 5 }] };
assert.equal(bookTick(book), 0.1);
const l = tickLadder(book, 0.1, 4);
assert.deepEqual(l.asks.map((r) => [r.price, r.size]), [[1.2, 1], [1.3, 0], [1.4, 0], [1.5, 5]]);
assert.deepEqual(l.bids.map((r) => [r.price, r.size]), [[1.1, 4], [1, 0], [0.9, 0], [0.8, 5]]);
assert.ok(onRung(l.asks[2], 1.4000001, 0.1));
assert.ok(!onRung(l.asks[2], 1.3, 0.1));

// Без шага с сервера — оценка по минимальной дыре, запоминается и не пересчитывается.
const b2 = { venue: "y", symbol: "B", asks: [{ price: 10.02, size: 1 }, { price: 10.05, size: 1 }], bids: [{ price: 10, size: 1 }] };
assert.equal(bookTick(b2), 0.03);
assert.equal(bookTick({ ...b2, asks: [{ price: 10.01, size: 1 }, { price: 10.02, size: 1 }] }), 0.03);
// Шаг больше цены — мусор, отбрасываем.
assert.equal(bookTick({ venue: "z", symbol: "C", tick: 4, asks: [{ price: 0.2, size: 1 }, { price: 0.3, size: 1 }], bids: [] }), 0.1);
// Нет шага вовсе — сырые уровни.
assert.deepEqual(tickLadder({ asks: [{ price: 1, size: 1 }], bids: [] }, null, 3).asks.map((r) => r.price), [1]);

// PnL: лонг по bid, шорт по ask.
const ob = { bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }] };
assert.equal(livePnl({ side: "long", size: 2, entry: 100 }, ob), -2);
assert.equal(livePnl({ side: "short", size: 2, entry: 100 }, ob), -2);
assert.equal(livePnl({ side: "long", size: 2, entry: null }, ob), null);
assert.equal(livePnl({ side: "long", size: 2, entry: 100 }, null), null);
assert.equal(tickText(0.055833, 0.000001), "0.055833");
assert.equal(tickText(97000.1, 0.1), "97,000.1");
// Своя лимитка дальше n тиков — сетка растягивается до неё (и не дальше 200 лишних тиков).
const far = tickLadder(book, 0.1, 4, [2.0, 0.4, 1.15]);
assert.equal(far.asks.length, 9); assert.equal(far.asks.at(-1)!.price, 2);
assert.equal(far.bids.length, 8); assert.equal(far.bids.at(-1)!.price, 0.4);
assert.equal(tickLadder(book, 0.1, 4, [1000]).asks.length, 204);
console.log("ok");
