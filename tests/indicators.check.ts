// Самопроверка индикаторов графика: node tests/indicators.check.ts (запускает и pytest).
import assert from "node:assert/strict";
import { applyTrade, bollinger, ema, macd, mergeLatest, rsi, sma, vwap } from "../web/src/indicators.ts";

const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} != ${b}`);

assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
const e = ema([1, 2, 3, 4, 5], 3);                       // старт SMA(1,2,3)=2, k=0.5
assert.deepEqual(e.slice(0, 2), [null, null]);
near(e[2], 2); near(e[3], 3); near(e[4], 4);

const bb = bollinger([1, 1, 1, 1], 2, 2);
near(bb.up[3], 1); near(bb.low[3], 1);
const bb2 = bollinger([1, 3], 2, 1);                     // среднее 2, sd 1
near(bb2.up[1], 3); near(bb2.low[1], 1);

const up = Array.from({ length: 30 }, (_, i) => i);
near(rsi(up, 14)[29], 100);
const zig = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : 0));
assert.ok(Math.abs((rsi(zig, 14)[39] as number) - 50) < 5);

const m = macd(Array.from({ length: 60 }, (_, i) => 100 + i));
assert.equal(m.line[24], null);
assert.ok((m.line[59] as number) > 0 && m.hist[59] !== null);

const day = 86_400_000;
const vw = vwap([
  { t: 0, o: 1, h: 3, l: 1, c: 2, v: 1 },                 // typical 2
  { t: 60_000, o: 2, h: 4, l: 2, c: 3, v: 3 },            // typical 3 → (2+9)/4
  { t: day, o: 5, h: 5, l: 5, c: 5, v: 2 },               // новый день — заново
]);
near(vw[1], 11 / 4); near(vw[2], 5);

let bars = [{ t: 0, o: 10, h: 10, l: 10, c: 10, v: 1 }];
bars = applyTrade(bars, 60_000, 30_000, 12, 2);
assert.deepEqual(bars, [{ t: 0, o: 10, h: 12, l: 10, c: 12, v: 3 }]);
bars = applyTrade(bars, 60_000, 61_000, 9, 1);
assert.deepEqual(bars[1], { t: 60_000, o: 9, h: 9, l: 9, c: 9, v: 1 });
assert.equal(applyTrade(bars, 60_000, 1_000, 99, 1), bars);   // старая сделка не трогает историю
const merged = mergeLatest(bars, [{ t: 60_000, o: 9, h: 11, l: 8, c: 10, v: 5 }]);
assert.equal(merged.length, 2); assert.equal(merged[1].h, 11);
console.log("indicators ok");
