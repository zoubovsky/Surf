import { INTERVAL_MS, type Candle, type Interval } from "@surf/core";
import { HttpError, buildUrl, getJson, type Pacer, type RequestOptions } from "../http.js";
import { normalizeSeries } from "../aggregate.js";
import { parseBinanceStyleKlines } from "./klines.js";

export const BINANCE_API_BASE = "https://api.binance.com";
export const BINANCE_VENUE = "binance";
export const BINANCE_KLINES_MAX_LIMIT = 1000;

/**
 * Binance refuses requests from restricted locations (US and many cloud ranges) with HTTP 451 and body
 * `{"code":0,"msg":"Service unavailable from a restricted location ..."}`. Surfaced as a typed error so the
 * daemon can fall back to another venue instead of retrying.
 */
export class GeoBlockedError extends Error {
  override readonly name = "GeoBlockedError";
  readonly venue = BINANCE_VENUE;
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${BINANCE_VENUE} is geo-blocked from this location (HTTP ${status})`);
  }
}

export function isGeoBlockResponse(status: number, body: string): boolean {
  return status === 451 || (status === 403 && /restricted location/i.test(body));
}

function translateError(err: unknown): never {
  if (err instanceof HttpError && isGeoBlockResponse(err.status, err.body)) {
    throw new GeoBlockedError(err.url, err.status, err.body);
  }
  throw err;
}

export interface BinanceKlinesParams extends RequestOptions {
  /** e.g. "BTCUSDT". */
  symbol: string;
  interval: Interval;
  startTime?: number;
  endTime?: number;
  /** ≤ 1000. */
  limit?: number;
}

export function parseBinanceKlines(raw: unknown, ctx: { symbol: string; interval: Interval }): Candle[] {
  return parseBinanceStyleKlines(raw, { venue: BINANCE_VENUE, symbol: ctx.symbol, interval: ctx.interval });
}

/** GET /api/v3/klines. Throws `GeoBlockedError` on HTTP 451. Not the default venue — see README. */
export async function fetchBinanceKlines(p: BinanceKlinesParams): Promise<Candle[]> {
  const url = buildUrl(p.baseUrl ?? BINANCE_API_BASE, "api/v3/klines", {
    symbol: p.symbol,
    interval: p.interval,
    startTime: p.startTime,
    endTime: p.endTime,
    limit: Math.min(p.limit ?? BINANCE_KLINES_MAX_LIMIT, BINANCE_KLINES_MAX_LIMIT),
  });
  const raw = await getJson(url, p).catch(translateError);
  return parseBinanceKlines(raw, { symbol: p.symbol, interval: p.interval });
}

export interface BinanceBackfillParams extends RequestOptions {
  symbol: string;
  interval: Interval;
  from: number;
  to: number;
  pacer?: Pacer;
  onPage?: (page: Candle[]) => void;
  maxPages?: number;
}

/** Walk /klines forward in 1000-candle pages. Throws `GeoBlockedError` on the first blocked response. */
export async function backfillBinance(p: BinanceBackfillParams): Promise<Candle[]> {
  const ms = INTERVAL_MS[p.interval];
  const out: Candle[] = [];
  let cursor = p.from;
  let pages = 0;
  const maxPages = p.maxPages ?? 1000;
  while (cursor <= p.to && pages < maxPages) {
    if (p.pacer) await p.pacer.wait();
    const page = await fetchBinanceKlines({
      ...p,
      startTime: cursor,
      endTime: p.to,
      limit: BINANCE_KLINES_MAX_LIMIT,
    });
    pages++;
    if (page.length === 0) break;
    out.push(...page);
    p.onPage?.(page);
    const next = page[page.length - 1]!.openTime + ms;
    if (next <= cursor) break;
    cursor = next;
    if (page.length < BINANCE_KLINES_MAX_LIMIT) break;
  }
  return normalizeSeries(out.filter((c) => c.openTime >= p.from && c.openTime <= p.to));
}
