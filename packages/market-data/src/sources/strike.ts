import { z } from "zod";
import { INTERVAL_MS, type Candle, type Interval } from "@surf/core";
import { buildUrl, getJson, type Pacer, type RequestOptions } from "../http.js";
import { normalizeSeries } from "../aggregate.js";
import { numeric, parseBinanceStyleKlines } from "./klines.js";

export const STRIKE_API_BASE = "https://api.strikefinance.org";
export const STRIKE_VENUE = "strike";
/** First 1h candle available from Strike's kline store (observed 2026-03-19T17:00Z; docs say 2026-03-20). */
export const STRIKE_HISTORY_START = Date.UTC(2026, 2, 20);
export const STRIKE_KLINES_MAX_LIMIT = 1500;

export type StrikePriceType = "index" | "mark" | "last";

export interface StrikeKlinesParams extends RequestOptions {
  symbol: string;
  interval: Interval;
  priceType: StrikePriceType;
  /** Unix ms, inclusive. */
  startTime?: number;
  /** Unix ms, inclusive. */
  endTime?: number;
  /** Clamped to 1500 by the server. */
  limit?: number;
}

export function parseStrikeKlines(raw: unknown, ctx: { symbol: string; interval: Interval }): Candle[] {
  return parseBinanceStyleKlines(raw, { venue: STRIKE_VENUE, symbol: ctx.symbol, interval: ctx.interval });
}

/** GET /price/v2/klines. Returns sorted, deduped candles with venue "strike". */
export async function fetchStrikeKlines(p: StrikeKlinesParams): Promise<Candle[]> {
  const url = buildUrl(p.baseUrl ?? STRIKE_API_BASE, "price/v2/klines", {
    symbol: p.symbol,
    interval: p.interval,
    priceType: p.priceType,
    startTime: p.startTime,
    endTime: p.endTime,
    limit: Math.min(p.limit ?? STRIKE_KLINES_MAX_LIMIT, STRIKE_KLINES_MAX_LIMIT),
  });
  const raw = await getJson(url, p);
  return parseStrikeKlines(raw, { symbol: p.symbol, interval: p.interval });
}

export interface StrikeBackfillParams extends RequestOptions {
  symbol: string;
  interval: Interval;
  priceType: StrikePriceType;
  /** Unix ms, inclusive openTime lower bound. */
  from: number;
  /** Unix ms, inclusive openTime upper bound. */
  to: number;
  pacer?: Pacer;
  /** Called after every page (for progress logging). */
  onPage?: (page: Candle[]) => void;
  /** Safety valve against runaway loops. Default 1000 pages. */
  maxPages?: number;
}

/** Walk /klines forward in 1500-candle pages from `from` to `to`. */
export async function backfillStrikeKlines(p: StrikeBackfillParams): Promise<Candle[]> {
  const ms = INTERVAL_MS[p.interval];
  const out: Candle[] = [];
  let cursor = p.from;
  let pages = 0;
  const maxPages = p.maxPages ?? 1000;
  while (cursor <= p.to && pages < maxPages) {
    if (p.pacer) await p.pacer.wait();
    const page = await fetchStrikeKlines({
      ...p,
      startTime: cursor,
      endTime: p.to,
      limit: STRIKE_KLINES_MAX_LIMIT,
    });
    pages++;
    if (page.length === 0) break;
    out.push(...page);
    p.onPage?.(page);
    const last = page[page.length - 1]!;
    const next = last.openTime + ms;
    if (next <= cursor) break; // no forward progress — server ignored startTime
    cursor = next;
    if (page.length < STRIKE_KLINES_MAX_LIMIT) break; // short page: reached the end of available data
  }
  return normalizeSeries(out.filter((c) => c.openTime >= p.from && c.openTime <= p.to));
}

/**
 * Shape shared by the /stat/v1/stats/coin/history/* endpoints:
 * `columns` names the fields of each row of `data`; `symbol` echoes the query; `days` or `interval` describes the range.
 */
export const StrikeHistoryResponse = z.object({
  columns: z.array(z.string()),
  data: z.array(z.array(z.unknown())),
  symbol: z.string().optional(),
  interval: z.string().optional(),
  days: z.number().optional(),
});
export type StrikeHistoryResponse = z.infer<typeof StrikeHistoryResponse>;

function rowsToRecords(resp: StrikeHistoryResponse): Record<string, unknown>[] {
  return resp.data.map((row, i) => {
    if (row.length !== resp.columns.length) {
      throw new Error(`strike history: row ${i} has ${row.length} fields, expected ${resp.columns.length}`);
    }
    const rec: Record<string, unknown> = {};
    resp.columns.forEach((col, j) => {
      rec[col] = row[j];
    });
    return rec;
  });
}

export interface FundingPoint {
  /** Unix ms of the funding interval. Observed spacing: hourly. */
  ts: number;
  /** Funding rate as a fraction per interval (0.0000125 = 0.00125%). Positive = longs pay shorts. */
  fundingRate: number;
}

export interface StrikeFundingHistory {
  symbol: string;
  days: number | null;
  /** Ascending by ts. */
  points: FundingPoint[];
}

const FundingRecord = z.object({ ts: z.number().int(), funding_rate: numeric });

export function parseStrikeFundingHistory(raw: unknown): StrikeFundingHistory {
  const resp = StrikeHistoryResponse.parse(raw);
  const points = rowsToRecords(resp)
    .map((r) => FundingRecord.parse(r))
    .map((r) => ({ ts: r.ts, fundingRate: r.funding_rate }))
    .sort((a, b) => a.ts - b.ts);
  return { symbol: resp.symbol ?? "", days: resp.days ?? null, points };
}

export interface StrikeFundingHistoryParams extends RequestOptions {
  symbol: string;
  /** 1–90, server default 30. */
  days?: number;
}

/** GET /stat/v1/stats/coin/history/funding?symbol=BTC-USD[&days=30] */
export async function fetchStrikeFundingHistory(
  p: StrikeFundingHistoryParams,
): Promise<StrikeFundingHistory> {
  const url = buildUrl(p.baseUrl ?? STRIKE_API_BASE, "stat/v1/stats/coin/history/funding", {
    symbol: p.symbol,
    days: p.days,
  });
  return parseStrikeFundingHistory(await getJson(url, p));
}

export interface OpenInterestPoint {
  ts: number;
  /** Open interest in base units (BTC) as reported by Strike. */
  openInterest: number;
  /** Traded volume in base units during the bucket. */
  volume: number;
}

export type StrikeOiInterval = "10m" | "15m" | "30m" | "1h" | "12h" | "1d";

export interface StrikeOpenInterestHistory {
  symbol: string;
  interval: string | null;
  /** Ascending by ts. */
  points: OpenInterestPoint[];
}

const OiRecord = z.object({ ts: z.number().int(), open_interest: numeric, volume: numeric });

export function parseStrikeOpenInterestHistory(raw: unknown): StrikeOpenInterestHistory {
  const resp = StrikeHistoryResponse.parse(raw);
  const points = rowsToRecords(resp)
    .map((r) => OiRecord.parse(r))
    .map((r) => ({ ts: r.ts, openInterest: r.open_interest, volume: r.volume }))
    .sort((a, b) => a.ts - b.ts);
  return { symbol: resp.symbol ?? "", interval: resp.interval ?? null, points };
}

export interface StrikeOpenInterestParams extends RequestOptions {
  symbol: string;
  /** Aggregation bucket; server default 10m. Range = server max_points x interval. */
  interval?: StrikeOiInterval;
}

/** GET /stat/v1/stats/coin/history/open-interest?symbol=BTC-USD[&interval=1h] */
export async function fetchStrikeOpenInterestHistory(
  p: StrikeOpenInterestParams,
): Promise<StrikeOpenInterestHistory> {
  const url = buildUrl(p.baseUrl ?? STRIKE_API_BASE, "stat/v1/stats/coin/history/open-interest", {
    symbol: p.symbol,
    interval: p.interval,
  });
  return parseStrikeOpenInterestHistory(await getJson(url, p));
}

export const StrikePremiumIndex = z
  .object({
    symbol: z.string(),
    markPrice: numeric,
    indexPrice: numeric,
    latestPremiumIndex: numeric.optional(),
    averagePremiumIndex: numeric.optional(),
    premiumIndexCount: z.number().optional(),
    /** Fraction per funding interval (hourly on Strike). */
    fundingRate: numeric,
    nextFundingTime: z.number().int(),
    interestRate: numeric.optional(),
    interestRateDampener: numeric.optional(),
    time: z.number().int(),
  })
  .transform((r) => ({
    symbol: r.symbol,
    markPrice: r.markPrice,
    indexPrice: r.indexPrice,
    fundingRate: r.fundingRate,
    nextFundingTime: r.nextFundingTime,
    latestPremiumIndex: r.latestPremiumIndex ?? null,
    averagePremiumIndex: r.averagePremiumIndex ?? null,
    interestRate: r.interestRate ?? null,
    time: r.time,
  }));
export type StrikePremiumIndex = z.infer<typeof StrikePremiumIndex>;

export function parseStrikePremiumIndex(raw: unknown): StrikePremiumIndex {
  return StrikePremiumIndex.parse(raw);
}

export interface StrikePremiumIndexParams extends RequestOptions {
  symbol: string;
}

/** GET /price/v2/premiumIndex?symbol=BTC-USD → mark, index, funding rate, next funding time. */
export async function fetchStrikePremiumIndex(p: StrikePremiumIndexParams): Promise<StrikePremiumIndex> {
  const url = buildUrl(p.baseUrl ?? STRIKE_API_BASE, "price/v2/premiumIndex", { symbol: p.symbol });
  return parseStrikePremiumIndex(await getJson(url, p));
}
