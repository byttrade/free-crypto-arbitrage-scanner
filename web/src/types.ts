export type VenueId =
  | "binance"
  | "bybit"
  | "okx"
  | "bingx"
  | "kucoin"
  | "hyperliquid"
  | "bitget"
  | "gate"
  | "mexc"
  | "htx"
  | "blofin";

export type MarketKind = "spot" | "perp";

export type CrossSpread = {
  id: string;
  base: string;
  quote: string;
  kind: MarketKind;
  buyVenue: VenueId;
  sellVenue: VenueId;
  buySymbol: string;
  sellSymbol: string;
  buyAsk: number;
  sellBid: number;
  spreadPct: number;
  netPct: number;
  volumeUsd: number;
  ts: number;
  buyFundingPct?: number | null;
  sellFundingPct?: number | null;
  buyIntervalH?: number | null;
  sellIntervalH?: number | null;
  fundingPct?: number | null;
  funding8hPct?: number | null;
  feesPct?: number;
  fundNextPct?: number | null;
  fundNextAt?: number | null;
  ageSec?: number;
  avgPct?: number;
  execPct?: number | null;
  execNetPct?: number | null;
  execUsd?: number;
  transfer?: "ok" | "blocked" | "unknown";
  transferWhy?: "withdraw" | "deposit" | "";
  transferVenue?: VenueId | "";
};

export type FundingRow = {
  id: string;
  venue: VenueId;
  symbol: string;
  base: string;
  quote: string;
  fundingPct: number;
  intervalH?: number | null;
  mark: number;
  index?: number;
  basisPct: number;
  volumeUsd: number;
  ts: number;
};

export type PairSignal = {
  entryTs: number;
  exitTs: number | null;
  entryZ: number;
  exitZ: number | null;
  hours: number | null;
  maxAdverseZ: number;
  reverted: boolean;
};

export type PairRow = {
  id: string;
  y: string;
  x: string;
  yVenue: VenueId;
  xVenue: VenueId;
  ySymbol: string;
  xSymbol: string;
  corr: number;
  cointP: number;
  hedge: number;
  halfLifeBars: number;
  halfLifeHours?: number | null;
  cointAgeBars?: number;
  sampleFrom?: number;
  sampleTo?: number;
  z: number;
  spreadNow: number;
  winRate: number;
  trades: number;
  avgHours: number;
  lastSignal: PairSignal | null;
};

export type BookLevel = { price: number; size: number };

export type OrderBook = {
  venue: VenueId;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
};

export type TapeTrade = {
  venue: VenueId;
  symbol: string;
  ts: number;
  price: number;
  size: number;
  side: "buy" | "sell";
};

export type Settings = {
  telegramToken: string;
  telegramChatId: string;
  minSpreadPct: number;
  velocityPct: number;
  velocityWindowSec: number;
  cooldownSec: number;
  minVolumeUsd: number;
  minFundingPct: number;
  slippagePct: number;
  sizeUsd: number;
  corrMin: number;
  zEntry: number;
  zExit: number;
  tgMaxPerMin: number;
  maxQuoteAgeSec: number;
  watch: string[];
  watchNetPct: number;
};

export type AlertEvent = {
  id: string;
  kind: "threshold" | "velocity" | "funding" | "watch";
  title: string;
  text: string;
  ts: number;
};

export const VENUE_LABEL: Record<VenueId, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  bingx: "BingX",
  kucoin: "KuCoin",
  hyperliquid: "Hyperliquid",
  bitget: "Bitget",
  gate: "Gate",
  mexc: "MEXC",
  htx: "HTX",
  blofin: "BloFin",
};
