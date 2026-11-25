import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n, type Msg } from "./i18n";
import { bookTick, onRung, tickLadder, tickText } from "./ladder";
import type { BookLevel, LiveOrder, OrderBook, TapeTrade, VenueId } from "./types";
import { VENUE_LABEL } from "./types";

export type LegPick = {
  role: "buy" | "sell";
  side: "ask" | "bid";
  venue: string;
  symbol: string;
  kind: "spot" | "perp";
  price: number;
  size: number;
  quote?: number;
  quoteCcy?: "USDT" | "USD";
};

export const QUOTE_CHIPS = [10, 25, 50, 100, 250, 500, 1000];

export function Venue({ id }: { id: string }) {
  const name = VENUE_LABEL[id as VenueId] || id;
  return (
    <span className="venue">
      <img src={`/logos/${id}.svg`} alt="" />
      {name}
    </span>
  );
}

export function price(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

function size(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

function explain(
  t: (key: Msg, vars?: Record<string, string | number>) => string,
  role: "buy" | "sell",
  side: "ask" | "bid",
  venue: string,
  level: BookLevel,
) {
  const px = price(level.price);
  const vol = size(level.size);
  if (role === "buy" && side === "ask") return t("askBuy", { px, venue, vol });
  if (role === "buy" && side === "bid") return t("bidNotEntry", { px, venue });
  if (role === "sell" && side === "bid") return t("bidSell", { px, venue, vol });
  return t("askNotExit", { px, venue });
}

function Row({
  level,
  max,
  side,
  role,
  venue,
  mine,
  tick,
  onHint,
  onPick,
  onCancel,
}: {
  level: BookLevel;
  max: number;
  side: "ask" | "bid";
  role: "buy" | "sell";
  venue: string;
  mine: LiveOrder[];
  tick: number | null;
  onHint: (text: string) => void;
  onPick: (level: BookLevel, side: "ask" | "bid") => void;
  onCancel?: (row: LiveOrder) => void;
}) {
  const vol = <span className="vol">{level.size > 0 ? size(level.size) : ""}</span>;
  const px = <span className="px">{tickText(level.price, tick) ?? price(level.price)}</span>;
  const { t } = useI18n();
  const hot = (role === "buy" && side === "ask") || (role === "sell" && side === "bid");
  // Своя лимитка на этом тике: клик снимает её, а не ставит новую.
  const own = mine.length > 0 && onCancel;
  const text = own
    ? `${t("cancelHit")} ${mine.map((o) => `${o.side} ${o.size ?? ""} @ ${price(o.price || 0)}`).join(" · ")}`
    : explain(t, role, side, venue, level);
  return (
    <button
      type="button"
      className={`ladder-row pop ${side} ${role}${own ? " mine" : ""}`}
      onMouseEnter={() => onHint(text)}
      onFocus={() => onHint(text)}
      onClick={() => (own ? mine.forEach((o) => onCancel(o)) : onPick(level, side))}
    >
      <div className="bar" style={{ "--w": level.size > 0 ? Math.max(0.06, level.size / max) : 0 } as React.CSSProperties} />
      {role === "buy" ? (
        <>
          {vol}
          {px}
        </>
      ) : (
        <>
          {px}
          {vol}
        </>
      )}
      {own ? (
        <em className="row-act row-x">× {mine.map((o) => o.side).join("/")}</em>
      ) : (
        <em className="row-act">{hot ? (role === "buy" ? t("buyBtn") : t("sellBtn")) : t("rowPrice")}</em>
      )}
    </button>
  );
}

export function Book({
  book,
  role,
  venue,
  symbol,
  updatedAt,
  onPick,
  kind,
  quote,
  quoteCcy,
  onQuote,
  onCcy,
  freeUsdt,
  orders = [],
  onCancel,
}: {
  book: OrderBook | null;
  role: "buy" | "sell";
  venue?: string;
  symbol?: string;
  updatedAt?: number;
  onPick?: (leg: LegPick) => void;
  kind?: "spot" | "perp";
  quote: number;
  quoteCcy: "USDT" | "USD";
  onQuote: (n: number) => void;
  onCcy: (ccy: "USDT" | "USD") => void;
  freeUsdt?: number | null;
  orders?: LiveOrder[];
  onCancel?: (row: LiveOrder) => void;
}) {
  // Фиксированная сетка тиков: пустой тик остаётся строкой, строки не прыгают на каждом апдейте.
  // Своя дальняя лимитка растягивает сетку — она всегда видна и снимается кликом.
  const legOrders = orders.filter((o) => o.venue === venue && o.symbol === symbol && o.kind === (kind || "perp") && o.price);
  const tick = book ? bookTick(book) : null;
  const rungs = book ? tickLadder(book, tick, 14, legOrders.map((o) => o.price!)) : { asks: [], bids: [] };
  const asks = [...rungs.asks].reverse();
  const bids = rungs.bids;
  const mineAt = (r: (typeof bids)[number]) => legOrders.filter((o) => onRung(r, o.price!, tick));
  const max = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const bestAsk = book?.asks[0];
  const bestBid = book?.bids[0];
  const name = venue ? VENUE_LABEL[venue as VenueId] || venue : "—";
  const age = book?.ts ? Math.max(0, ((updatedAt || Date.now()) - book.ts) / 1000) : null;
  const { lang, t } = useI18n();
  const [hint, setHint] = useState(role === "buy" ? t("hintBuy") : t("hintSell"));
  useEffect(() => {
    setHint(role === "buy" ? t("hintBuy") : t("hintSell"));
  }, [lang, role]);

  // Лучшие цены — у линии ask/bid посередине: при открытии пары прокручиваем к ней, дальше не мешаем.
  const ladderRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<HTMLDivElement>(null);
  const centered = useRef("");
  useEffect(() => {
    const box = ladderRef.current;
    const line = touchRef.current;
    const id = `${venue}|${symbol}`;
    if (!book || !box || !line || centered.current === id) return;
    centered.current = id;
    box.scrollTop = line.offsetTop - box.clientHeight / 2 + line.offsetHeight / 2;
  }, [book, venue, symbol]);

  const pick = (level: BookLevel, side: "ask" | "bid") => {
    if (!venue || !symbol) return;
    const coins = level.price > 0 ? quote / level.price : 0;
    onPick?.({ role, side, venue, symbol, kind: kind || "perp", price: level.price, size: coins, quote, quoteCcy });
    setHint(`${explain(t, role, side, name, level)} ${t("coinsHint", { quote, ccy: quoteCcy, coins: coins.toPrecision(3) })}`);
  };

  const best = role === "buy" ? bestAsk : bestBid;
  const coins = best && best.price > 0 ? quote / best.price : 0;

  return (
    <>
      <header className={role}>
        <div>
          {venue && <img className="ex-logo" src={`/logos/${venue}.svg`} alt="" />}
          <b>{role === "buy" ? t("buyBook") : t("sellBook")}</b>
          <span>{name}</span>
        </div>
        <div className="sym">
          {symbol || t("pickLink")}
          {age != null && <em>{age < 1 ? "live" : `${age.toFixed(0)}${t("sec")}`}</em>}
        </div>
      </header>
      <div className="book-actions">
        <button
          type="button"
          className={`trade-btn pop ${role}`}
          disabled={!best || !venue}
          onClick={() => best && pick(best, role === "buy" ? "ask" : "bid")}
        >
          <span className="trade-name">
            {venue && <img className="ex-logo" src={`/logos/${venue}.svg`} alt="" />}
            {role === "buy" ? t("buyBtn") : t("sellBtn")} {quote} {quoteCcy}
          </span>
          <small>{best ? `${price(best.price)} · ${coins.toPrecision(3)}` : t("noPrice")}</small>
        </button>
        {freeUsdt != null && (
          <p className="avail">
            {t("free")} <b>{freeUsdt.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> USDT
          </p>
        )}
        <div className="quotes">
          {(["USDT", "USD"] as const).map((ccy) => (
            <button key={ccy} type="button" className={quoteCcy === ccy ? "on" : ""} onClick={() => onCcy(ccy)}>
              {ccy}
            </button>
          ))}
          {QUOTE_CHIPS.map((n) => (
            <button key={n} type="button" className={quote === n ? "on" : ""} onClick={() => onQuote(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">{hint}</p>
      <div className="cols">
        {role === "buy" ? (
          <>
            <span>{t("volCoin")}</span>
            <span>{t("price")}</span>
          </>
        ) : (
          <>
            <span>{t("price")}</span>
            <span>{t("volCoin")}</span>
          </>
        )}
      </div>
      <div className="ladder" ref={ladderRef} onMouseLeave={() => setHint(role === "buy" ? t("hintBuy") : t("hintSell"))}>
        {!book && (
          <div className="book-loader">
            <img src="/logos/byt.svg" alt="" />
            <span>{venue ? t("loadingBook") : t("pickLink")}</span>
          </div>
        )}
        {asks.map((l, i) => (
          <Row
            key={`a${i}`}
            level={l}
            max={max}
            side="ask"
            role={role}
            venue={name}
            mine={mineAt(l)}
            tick={tick}
            onHint={setHint}
            onPick={pick}
            onCancel={onCancel}
          />
        ))}
        <div className="touch" ref={touchRef}>
          <span className="neg">ask {bestAsk ? price(bestAsk.price) : "—"}</span>
          <span className="pos">bid {bestBid ? price(bestBid.price) : "—"}</span>
        </div>
        {bids.map((l, i) => (
          <Row
            key={`b${i}`}
            level={l}
            max={max}
            side="bid"
            role={role}
            venue={name}
            mine={mineAt(l)}
            tick={tick}
            onHint={setHint}
            onPick={pick}
            onCancel={onCancel}
          />
        ))}
      </div>
    </>
  );
}

export function Tape({
  trades,
  title,
  onDrag,
}: {
  trades: TapeTrade[];
  title: string;
  onDrag: (e: ReactPointerEvent) => void;
}) {
  const { lang, t } = useI18n();
  return (
    <div className="tape-box">
      <button type="button" className="tape-grip" onPointerDown={onDrag} title={t("dragTape")}>
        <i />
        {title}
      </button>
      <div className="cols tape-head">
        <span>{t("time")}</span>
        <span>{t("price")}</span>
        <span>{t("volume")}</span>
      </div>
      <div className="tape">
        {trades.slice(-80).reverse().map((trade, i) => (
          <div key={`${trade.ts}-${trade.price}-${trade.size}-${i}`}>
            <span className="muted">{trade.ts ? new Date(trade.ts).toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-GB", { hour12: false }) : ""}</span>
            <span className={trade.side === "buy" ? "pos" : "neg"}>{price(trade.price)}</span>
            <span>{size(trade.size)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
