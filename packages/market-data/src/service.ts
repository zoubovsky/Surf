import { INTERVAL_MS, floorToInterval, systemClock, type Candle, type Clock, type Interval } from "@surf/core";
import { aggregate, alignAndFill, type Gap } from "./aggregate.js";
import { crossCheck, referencePrice, type CrossCheckResult } from "./crosscheck.js";
import { Pacer, type RequestOptions } from "./http.js";
import {
  COINBASE_DEFAULT_RPS,
  COINBASE_MAX_CANDLES,
  COINBASE_VENUE,
  backfillCoinbase,
  fetchCoinbaseCandles,
  granularityFor,
} from "./sources/coinbase.js";
import {
  STRIKE_HISTORY_START,
  STRIKE_VENUE,
  backfillStrikeKlines,
  fetchStrikeFundingHistory,
  fetchStrikeKlines,
  fetchStrikeOpenInterestHistory,
  fetchStrikePremiumIndex,
  type FundingPoint,
  type OpenInterestPoint,
  type StrikeOiInterval,
  type StrikePremiumIndex,
  type StrikePriceType,
} from "./sources/strike.js";
import { CandleSeries, type CandleRepository } from "./store.js";
import { noopLogger, type FetchLike, type MarketLogger } from "./types.js";

export type Venue = typeof STRIKE_VENUE | typeof COINBASE_VENUE;

export interface MarketDataServiceOptions {
  fetch: FetchLike;
  clock?: Clock;
  logger?: MarketLogger;
  /** Optional durable store; when given, backfill resumes from what is already stored and closed candles are persisted. */
  repository?: CandleRepository;
  /** Strike symbol. Default "BTC-USD". */
  symbol?: string;
  /** Coinbase product. Default "BTC-USD". */
  coinbaseProduct?: string;
  /** Strike price series used as execution truth. Default "index". */
  strikePriceType?: StrikePriceType;
  /** Earliest Strike 1h candle to load. Default 2026-03-20T00:00Z. */
  strikeSince?: number;
  /** How far back to load Coinbase 1h history. Default 2 years. */
  coinbaseHistoryMs?: number;
  /** Max close-to-close deviation (percent) between Strike and Coinbase for the same bucket. Default 1. */
  maxDeviationPct?: number;
  /** Intervals derived from 1h by aggregation. Default ["4h"]. */
  aggregatedIntervals?: Exclude<Interval, "1h">[];
  /** Venue served by `getCandles`/`latestClosed` when none is given. Default "coinbase" (long history for the EW engine). */
  defaultVenue?: Venue;
  /** Cap on in-memory 1h candles per venue. Default 20,000 (≈2.3 years). */
  maxLength?: number;
  /** Coinbase request pacing. Default 5 req/s. */
  coinbaseRequestsPerSecond?: number;
  /** Strike stats: days of funding history (1–90, default 30) and OI bucket (default "1h"). */
  fundingDays?: number;
  openInterestInterval?: StrikeOiInterval;
  strikeBaseUrl?: string;
  coinbaseBaseUrl?: string;
  /** Passed through to every request. */
  request?: Pick<RequestOptions, "timeoutMs" | "attempts" | "headers">;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceError {
  source: string;
  error: unknown;
}

export interface BackfillSummary {
  strike: { fetched: number; from: number; to: number };
  coinbase: { fetched: number; from: number; to: number };
  gaps: Record<string, Gap[]>;
  crossCheck: CrossCheckResult | null;
  errors: SourceError[];
}

export interface RefreshResult {
  now: number;
  strikeLatestClosed: Candle | null;
  coinbaseLatestClosed: Candle | null;
  newCandles: { strike: number; coinbase: number };
  crossCheck: CrossCheckResult | null;
  errors: SourceError[];
}

const TWO_YEARS_MS = 730 * 86_400_000;

/**
 * Orchestrates the candle, funding and open-interest feeds for one symbol:
 *  - backfill: Strike index 1h since 2026-03-20 (execution truth) + Coinbase 1h back to `coinbaseHistoryMs`
 *  - refresh(now): incremental pull after each hourly close, aggregation to 4h, cross-check of the latest bucket
 * All network access goes through the injected `fetch`; time through `clock`.
 */
export class MarketDataService {
  readonly symbol: string;
  readonly coinbaseProduct: string;
  readonly defaultVenue: Venue;
  private readonly clock: Clock;
  private readonly log: MarketLogger;
  private readonly repo: CandleRepository | undefined;
  private readonly priceType: StrikePriceType;
  private readonly strikeSince: number;
  private readonly coinbaseHistoryMs: number;
  private readonly maxDeviationPct: number;
  private readonly aggregated: Exclude<Interval, "1h">[];
  private readonly series = new Map<string, CandleSeries>();
  private readonly maxLength: number;
  private readonly coinbasePacer: Pacer;
  private readonly fundingDays: number | undefined;
  private readonly oiInterval: StrikeOiInterval;
  private readonly strikeReq: RequestOptions;
  private readonly coinbaseReq: RequestOptions;

  private fundingPoints: FundingPoint[] = [];
  private oiPoints: OpenInterestPoint[] = [];
  private premium: StrikePremiumIndex | null = null;
  private lastCheck: CrossCheckResult | null = null;
  private gapsByKey = new Map<string, Gap[]>();

  constructor(opts: MarketDataServiceOptions) {
    this.symbol = opts.symbol ?? "BTC-USD";
    this.coinbaseProduct = opts.coinbaseProduct ?? "BTC-USD";
    this.defaultVenue = opts.defaultVenue ?? COINBASE_VENUE;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? noopLogger;
    this.repo = opts.repository;
    this.priceType = opts.strikePriceType ?? "index";
    this.strikeSince = opts.strikeSince ?? STRIKE_HISTORY_START;
    this.coinbaseHistoryMs = opts.coinbaseHistoryMs ?? TWO_YEARS_MS;
    this.maxDeviationPct = opts.maxDeviationPct ?? 1;
    this.aggregated = opts.aggregatedIntervals ?? ["4h"];
    this.maxLength = opts.maxLength ?? 20_000;
    this.fundingDays = opts.fundingDays;
    this.oiInterval = opts.openInterestInterval ?? "1h";
    const sleep = opts.sleep;
    this.coinbasePacer = Pacer.perSecond(
      opts.coinbaseRequestsPerSecond ?? COINBASE_DEFAULT_RPS,
      sleep ? { now: () => this.clock.now(), sleep } : undefined,
    );
    const shared: RequestOptions = { fetch: opts.fetch, ...opts.request };
    this.strikeReq = opts.strikeBaseUrl ? { ...shared, baseUrl: opts.strikeBaseUrl } : shared;
    this.coinbaseReq = opts.coinbaseBaseUrl ? { ...shared, baseUrl: opts.coinbaseBaseUrl } : shared;
  }

  // ---------------------------------------------------------------- series access

  private key(venue: Venue, interval: Interval): string {
    return `${venue}:${interval}`;
  }

  /** The underlying series (created on demand). */
  getSeries(venue: Venue, interval: Interval): CandleSeries {
    const k = this.key(venue, interval);
    let s = this.series.get(k);
    if (!s) {
      const cap = interval === "1h" ? this.maxLength : Math.ceil((this.maxLength * INTERVAL_MS["1h"]) / INTERVAL_MS[interval]) + 1;
      s = new CandleSeries(interval, { maxLength: cap });
      this.series.set(k, s);
    }
    return s;
  }

  /** Last `n` *closed* candles (as of the clock), oldest first. */
  getCandles(interval: Interval, n: number, venue: Venue = this.defaultVenue): Candle[] {
    return this.getSeries(venue, interval).sliceClosed(n, this.clock.now());
  }

  /** Newest closed candle for the interval, or null. */
  latestClosed(interval: Interval, venue: Venue = this.defaultVenue): Candle | null {
    return this.getSeries(venue, interval).latestClosed(this.clock.now()) ?? null;
  }

  get lastCrossCheck(): CrossCheckResult | null {
    return this.lastCheck;
  }

  /** Funding history, ascending. Empty until the first successful backfill/refresh. */
  funding(): FundingPoint[] {
    return this.fundingPoints;
  }

  latestFunding(): FundingPoint | null {
    return this.fundingPoints[this.fundingPoints.length - 1] ?? null;
  }

  /** Open interest history, ascending. */
  openInterest(): OpenInterestPoint[] {
    return this.oiPoints;
  }

  latestOpenInterest(): OpenInterestPoint | null {
    return this.oiPoints[this.oiPoints.length - 1] ?? null;
  }

  /** Latest premiumIndex snapshot (mark, index, funding rate, next funding time), or null. */
  premiumIndex(): StrikePremiumIndex | null {
    return this.premium;
  }

  /** External reference price for the risk engine: Coinbase latest closed 1h close, else Strike index. */
  referencePrice(): number | null {
    return referencePrice(this.latestClosed("1h", COINBASE_VENUE)?.close ?? null, this.premium?.indexPrice ?? null);
  }

  /** Gaps detected in the 1h series of a venue at the last backfill/refresh. */
  gaps(venue: Venue, interval: Interval = "1h"): Gap[] {
    return this.gapsByKey.get(this.key(venue, interval)) ?? [];
  }

  // ---------------------------------------------------------------- backfill

  async backfill(): Promise<BackfillSummary> {
    const now = this.clock.now();
    const errors: SourceError[] = [];
    const hour = INTERVAL_MS["1h"];

    const strikeStart = Math.max(
      floorToInterval(this.strikeSince, hour),
      (await this.resumePoint(STRIKE_VENUE, this.symbol)) ?? -Infinity,
    );
    const coinbaseStart = Math.max(
      floorToInterval(now - this.coinbaseHistoryMs, hour),
      (await this.resumePoint(COINBASE_VENUE, this.coinbaseProduct)) ?? -Infinity,
    );
    const to = floorToInterval(now, hour); // include the in-progress bucket; latestClosed guards consumers

    let strikeFetched = 0;
    try {
      const candles = await backfillStrikeKlines({
        ...this.strikeReq,
        symbol: this.symbol,
        interval: "1h",
        priceType: this.priceType,
        from: strikeStart,
        to,
        onPage: (page) => this.log.debug({ venue: STRIKE_VENUE, n: page.length, first: page[0]?.openTime }, "backfill page"),
      });
      strikeFetched = candles.length;
      await this.ingest(STRIKE_VENUE, candles, now);
    } catch (error) {
      errors.push({ source: "strike.klines", error });
      this.log.error({ err: String(error) }, "strike backfill failed");
    }

    let coinbaseFetched = 0;
    try {
      const candles = await backfillCoinbase({
        ...this.coinbaseReq,
        product: this.coinbaseProduct,
        granularity: granularityFor("1h"),
        from: coinbaseStart,
        to,
        pacer: this.coinbasePacer,
        onPage: (page, w) => this.log.debug({ venue: COINBASE_VENUE, n: page.length, start: w.start }, "backfill page"),
      });
      coinbaseFetched = candles.length;
      await this.ingest(COINBASE_VENUE, candles, now);
    } catch (error) {
      errors.push({ source: "coinbase.candles", error });
      this.log.error({ err: String(error) }, "coinbase backfill failed");
    }

    errors.push(...(await this.refreshStats()));
    this.runCrossCheck(now);
    this.log.info({ strikeFetched, coinbaseFetched, errors: errors.length }, "backfill complete");
    return {
      strike: { fetched: strikeFetched, from: strikeStart, to },
      coinbase: { fetched: coinbaseFetched, from: coinbaseStart, to },
      gaps: Object.fromEntries(this.gapsByKey),
      crossCheck: this.lastCheck,
      errors,
    };
  }

  /** Load what the repository already has into memory and return the openTime to resume from (last stored + 1h). */
  private async resumePoint(venue: Venue, symbol: string): Promise<number | null> {
    if (!this.repo) return null;
    const stored = await this.repo.range({ venue, symbol, interval: "1h" });
    if (stored.length === 0) return null;
    const series = this.getSeries(venue, "1h");
    series.upsert(stored);
    for (const iv of this.aggregated) {
      const agg = await this.repo.range({ venue, symbol, interval: iv });
      if (agg.length) this.getSeries(venue, iv).upsert(agg);
    }
    this.log.info({ venue, stored: stored.length, last: series.latest()?.openTime }, "resuming from repository");
    return series.latest()!.openTime + INTERVAL_MS["1h"];
  }

  // ---------------------------------------------------------------- refresh

  /** Incremental pull. Call ~1 minute after each hourly close. Never throws for source failures; see `errors`. */
  async refresh(now: number = this.clock.now()): Promise<RefreshResult> {
    const errors: SourceError[] = [];
    const hour = INTERVAL_MS["1h"];
    const newCandles = { strike: 0, coinbase: 0 };

    const strikeSeries = this.getSeries(STRIKE_VENUE, "1h");
    const strikeFrom = strikeSeries.latest()?.openTime ?? Math.max(this.strikeSince, floorToInterval(now, hour) - 48 * hour);
    try {
      const candles = await fetchStrikeKlines({
        ...this.strikeReq,
        symbol: this.symbol,
        interval: "1h",
        priceType: this.priceType,
        startTime: strikeFrom,
        limit: Math.min(1500, Math.ceil((now - strikeFrom) / hour) + 2),
      });
      newCandles.strike = await this.ingest(STRIKE_VENUE, candles, now);
    } catch (error) {
      errors.push({ source: "strike.klines", error });
      this.log.warn({ err: String(error) }, "strike refresh failed");
    }

    const cbSeries = this.getSeries(COINBASE_VENUE, "1h");
    const cbFrom = cbSeries.latest()?.openTime ?? floorToInterval(now, hour) - 48 * hour;
    try {
      await this.coinbasePacer.wait();
      const candles = await fetchCoinbaseCandles({
        ...this.coinbaseReq,
        product: this.coinbaseProduct,
        granularity: granularityFor("1h"),
        start: Math.max(cbFrom, floorToInterval(now, hour) - (COINBASE_MAX_CANDLES - 1) * hour),
        end: floorToInterval(now, hour),
      });
      newCandles.coinbase = await this.ingest(COINBASE_VENUE, candles, now);
    } catch (error) {
      errors.push({ source: "coinbase.candles", error });
      this.log.warn({ err: String(error) }, "coinbase refresh failed");
    }

    errors.push(...(await this.refreshStats()));
    const check = this.runCrossCheck(now);
    return {
      now,
      strikeLatestClosed: strikeSeries.latestClosed(now) ?? null,
      coinbaseLatestClosed: cbSeries.latestClosed(now) ?? null,
      newCandles,
      crossCheck: check,
      errors,
    };
  }

  // ---------------------------------------------------------------- internals

  /** Upsert 1h candles, rebuild aggregates, record gaps, persist closed candles. Returns count of newly inserted 1h candles. */
  private async ingest(venue: Venue, candles: Candle[], now: number): Promise<number> {
    if (candles.length === 0) return 0;
    const series = this.getSeries(venue, "1h");
    const { inserted } = series.upsert(candles);

    const aligned = alignAndFill(series.all(), "1h");
    this.gapsByKey.set(this.key(venue, "1h"), aligned.gaps);
    if (aligned.gaps.length) {
      this.log.warn({ venue, gaps: aligned.gaps.length, missing: aligned.gaps.reduce((s, g) => s + g.missing, 0) }, "gaps in 1h series");
    }

    const touched: Candle[] = [];
    for (const iv of this.aggregated) {
      const agg = aggregate(series.all(), iv);
      const target = this.getSeries(venue, iv);
      target.upsert(agg);
      const firstNew = Math.min(...candles.map((c) => c.openTime));
      touched.push(...agg.filter((c) => c.openTime >= floorToInterval(firstNew, INTERVAL_MS[iv])));
    }

    if (this.repo) {
      const closed = [...candles, ...touched].filter((c) => c.closeTime <= now);
      if (closed.length) await this.repo.upsert(closed);
    }
    return inserted;
  }

  private async refreshStats(): Promise<SourceError[]> {
    const errors: SourceError[] = [];
    const results = await Promise.allSettled([
      fetchStrikeFundingHistory({ ...this.strikeReq, symbol: this.symbol, ...(this.fundingDays !== undefined ? { days: this.fundingDays } : {}) }),
      fetchStrikeOpenInterestHistory({ ...this.strikeReq, symbol: this.symbol, interval: this.oiInterval }),
      fetchStrikePremiumIndex({ ...this.strikeReq, symbol: this.symbol }),
    ]);
    const [funding, oi, premium] = results;
    if (funding.status === "fulfilled") this.fundingPoints = funding.value.points;
    else errors.push({ source: "strike.funding", error: funding.reason });
    if (oi.status === "fulfilled") this.oiPoints = oi.value.points;
    else errors.push({ source: "strike.openInterest", error: oi.reason });
    if (premium.status === "fulfilled") this.premium = premium.value;
    else errors.push({ source: "strike.premiumIndex", error: premium.reason });
    for (const e of errors) this.log.warn({ source: e.source, err: String(e.error) }, "stats refresh failed");
    return errors;
  }

  /** Compare the latest closed Strike 1h candle with Coinbase's candle for the same bucket. */
  private runCrossCheck(now: number): CrossCheckResult | null {
    const primary = this.getSeries(STRIKE_VENUE, "1h").latestClosed(now);
    if (!primary) return this.lastCheck;
    const secondary = this.getSeries(COINBASE_VENUE, "1h").at(primary.openTime) ?? null;
    this.lastCheck = crossCheck(primary, secondary, this.maxDeviationPct);
    if (!this.lastCheck.ok) this.log.warn(this.lastCheck, "cross-check failed");
    return this.lastCheck;
  }
}
