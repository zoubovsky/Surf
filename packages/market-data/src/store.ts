import { INTERVAL_MS, type Candle, type Interval } from "@surf/core";

export interface CandleSeriesOptions {
  /** Drop the oldest candles once the series exceeds this many. Default: unbounded. */
  maxLength?: number;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  /** Candles dropped from the front to respect `maxLength`. */
  evicted: number;
}

/**
 * In-memory, sorted (ascending openTime), deduped candle series for a single venue/symbol/interval.
 * `latestClosed(now)` never returns a candle whose closeTime is after `now`.
 */
export class CandleSeries {
  private items: Candle[] = [];
  readonly maxLength: number;

  constructor(
    readonly interval: Interval,
    opts: CandleSeriesOptions = {},
  ) {
    this.maxLength = opts.maxLength ?? Number.POSITIVE_INFINITY;
  }

  get size(): number {
    return this.items.length;
  }

  /** Index of the first candle with openTime >= t. */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.items[mid]!.openTime < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Insert or replace by openTime. A later upsert of the same openTime wins (candle revisions). */
  upsert(candles: readonly Candle[]): UpsertResult {
    let inserted = 0;
    let updated = 0;
    for (const c of candles) {
      if (c.interval !== this.interval) {
        throw new Error(`CandleSeries(${this.interval}): refusing ${c.interval} candle at ${c.openTime}`);
      }
      const i = this.lowerBound(c.openTime);
      if (i < this.items.length && this.items[i]!.openTime === c.openTime) {
        this.items[i] = c;
        updated++;
      } else {
        this.items.splice(i, 0, c);
        inserted++;
      }
    }
    let evicted = 0;
    if (this.items.length > this.maxLength) {
      evicted = this.items.length - this.maxLength;
      this.items.splice(0, evicted);
    }
    return { inserted, updated, evicted };
  }

  all(): readonly Candle[] {
    return this.items;
  }

  first(): Candle | undefined {
    return this.items[0];
  }

  /** Most recent candle, closed or not. */
  latest(): Candle | undefined {
    return this.items[this.items.length - 1];
  }

  at(openTime: number): Candle | undefined {
    const i = this.lowerBound(openTime);
    const c = this.items[i];
    return c && c.openTime === openTime ? c : undefined;
  }

  /** Last `n` candles (closed or not), oldest first. */
  slice(n: number): Candle[] {
    if (n <= 0) return [];
    return this.items.slice(Math.max(0, this.items.length - n));
  }

  /** Candles with openTime in [from, to]. */
  range(from: number, to: number): Candle[] {
    return this.items.slice(this.lowerBound(from), this.lowerBound(to + 1));
  }

  /** Every candle whose closeTime <= now, oldest first. */
  closedUpTo(now: number): Candle[] {
    // closeTime is monotonic with openTime for a fixed interval, so a cut on openTime is exact.
    const cut = now - INTERVAL_MS[this.interval] + 1; // openTime <= cut  <=>  closeTime <= now
    return this.items.slice(0, this.lowerBound(cut + 1));
  }

  /** Last `n` closed candles as of `now`, oldest first. */
  sliceClosed(n: number, now: number): Candle[] {
    const closed = this.closedUpTo(now);
    if (n <= 0) return [];
    return closed.slice(Math.max(0, closed.length - n));
  }

  /** Newest candle with closeTime <= now, or undefined. Never leaks the in-progress candle. */
  latestClosed(now: number): Candle | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i]!;
      if (c.closeTime <= now) return c;
    }
    return undefined;
  }

  clear(): void {
    this.items = [];
  }
}

export interface CandleRangeQuery {
  venue: string;
  symbol: string;
  interval: Interval;
  /** Inclusive openTime lower bound. */
  from?: number;
  /** Inclusive openTime upper bound. */
  to?: number;
  /** Return at most this many, newest first when combined with no `from`. Implementations return ascending order. */
  limit?: number;
}

/**
 * Persistence boundary. The daemon implements this over SQLite/Postgres (`candles` table keyed by
 * venue+symbol+interval+openTime). `upsert` must be idempotent; `range` returns ascending by openTime.
 */
export interface CandleRepository {
  upsert(candles: readonly Candle[]): Promise<void>;
  range(query: CandleRangeQuery): Promise<Candle[]>;
}
