import { z } from "zod";
import { INTERVAL_MS, type Candle, type Interval } from "@surf/core";
import { buildUrl, getJson, Pacer, type RequestOptions } from "../http.js";
import { normalizeSeries } from "../aggregate.js";

export const COINBASE_API_BASE = "https://api.exchange.coinbase.com";
export const COINBASE_VENUE = "coinbase";
/** Coinbase Exchange returns at most 300 candles per request. */
export const COINBASE_MAX_CANDLES = 300;
/** Public endpoint limit is 10 req/s; we stay at half of that by default. */
export const COINBASE_DEFAULT_RPS = 5;

export type CoinbaseGranularity = 3600 | 14400 | 86400;

export const GRANULARITY_TO_INTERVAL: Record<CoinbaseGranularity, Interval> = {
  3600: "1h",
  14400: "4h",
  86400: "1d",
};

export function granularityFor(interval: Interval): CoinbaseGranularity {
  return (INTERVAL_MS[interval] / 1000) as CoinbaseGranularity;
}

/** [time_s, low, high, open, close, volume], newest first. */
export const CoinbaseCandleRow = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
export const CoinbaseCandles = z.array(CoinbaseCandleRow);

export function parseCoinbaseCandles(
  raw: unknown,
  ctx: { product: string; granularity: CoinbaseGranularity },
): Candle[] {
  const rows = CoinbaseCandles.parse(raw);
  const interval = GRANULARITY_TO_INTERVAL[ctx.granularity];
  const ms = ctx.granularity * 1000;
  return normalizeSeries(
    rows.map((r) => {
      const openTime = r[0] * 1000;
      return {
        venue: COINBASE_VENUE,
        symbol: ctx.product,
        interval,
        openTime,
        closeTime: openTime + ms - 1,
        open: r[3],
        high: r[2],
        low: r[1],
        close: r[4],
        volume: Math.max(0, r[5]),
      };
    }),
  );
}

export interface CoinbaseCandlesParams extends RequestOptions {
  product: string;
  granularity: CoinbaseGranularity;
  /** Unix ms, inclusive. Both bounds must span ≤ 300 candles or the server returns 400. */
  start?: number;
  /** Unix ms, inclusive. */
  end?: number;
}

/** GET /products/{product}/candles. Without start/end the server returns the latest 300 (including the open one). */
export async function fetchCoinbaseCandles(p: CoinbaseCandlesParams): Promise<Candle[]> {
  const url = buildUrl(p.baseUrl ?? COINBASE_API_BASE, `products/${encodeURIComponent(p.product)}/candles`, {
    granularity: p.granularity,
    start: p.start === undefined ? undefined : new Date(p.start).toISOString(),
    end: p.end === undefined ? undefined : new Date(p.end).toISOString(),
  });
  return parseCoinbaseCandles(await getJson(url, p), { product: p.product, granularity: p.granularity });
}

export interface CoinbaseBackfillParams extends RequestOptions {
  product: string;
  granularity: CoinbaseGranularity;
  /** Unix ms, inclusive openTime lower bound. */
  from: number;
  /** Unix ms, inclusive openTime upper bound. */
  to: number;
  /** Default: 5 requests per second. */
  pacer?: Pacer;
  onPage?: (page: Candle[], window: { start: number; end: number }) => void;
}

/** Enumerate the [start, end] request windows (inclusive, ≤ 300 candles each) covering [from, to]. */
export function coinbaseWindows(
  from: number,
  to: number,
  granularity: CoinbaseGranularity,
): { start: number; end: number }[] {
  const ms = granularity * 1000;
  const span = (COINBASE_MAX_CANDLES - 1) * ms;
  const windows: { start: number; end: number }[] = [];
  for (let start = Math.floor(from / ms) * ms; start <= to; start += span + ms) {
    windows.push({ start, end: Math.min(start + span, to) });
  }
  return windows;
}

/** Walk the candle endpoint in 300-candle windows from `from` to `to` with polite pacing. */
export async function backfillCoinbase(p: CoinbaseBackfillParams): Promise<Candle[]> {
  const pacer = p.pacer ?? Pacer.perSecond(COINBASE_DEFAULT_RPS);
  const out: Candle[] = [];
  for (const window of coinbaseWindows(p.from, p.to, p.granularity)) {
    await pacer.wait();
    const page = await fetchCoinbaseCandles({ ...p, start: window.start, end: window.end });
    out.push(...page);
    p.onPage?.(page, window);
  }
  return normalizeSeries(out.filter((c) => c.openTime >= p.from && c.openTime <= p.to));
}
