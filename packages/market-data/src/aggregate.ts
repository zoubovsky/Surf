import { INTERVAL_MS, floorToInterval, type Candle, type Interval } from "@surf/core";

/** Sort ascending by openTime and dedupe (the last occurrence of an openTime wins). */
export function normalizeSeries(candles: readonly Candle[]): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

function assertSingleVenue(candles: readonly Candle[]): void {
  const first = candles[0];
  if (!first) return;
  for (const c of candles) {
    if (c.venue !== first.venue || c.symbol !== first.symbol) {
      throw new Error(`aggregate: mixed series (${first.venue}:${first.symbol} vs ${c.venue}:${c.symbol})`);
    }
  }
}

export interface AggregateOptions {
  /**
   * Only emit target candles whose bucket contains every source candle (default true).
   * With false, partial buckets are emitted too — callers must know the last one may be incomplete.
   */
  requireComplete?: boolean;
}

/**
 * Roll up candles into a coarser interval aligned to UTC (4h -> 00/04/08/12/16/20, 1d -> 00:00).
 * All input candles must share venue, symbol and a source interval that divides the target.
 * Misaligned source candles (openTime not on the source grid) throw — corrupted input must be loud.
 */
export function aggregate(
  candles: readonly Candle[],
  target: Interval,
  opts: AggregateOptions = {},
): Candle[] {
  const requireComplete = opts.requireComplete ?? true;
  const series = normalizeSeries(candles);
  const first = series[0];
  if (!first) return [];
  assertSingleVenue(series);

  const sourceMs = INTERVAL_MS[first.interval];
  const targetMs = INTERVAL_MS[target];
  if (targetMs <= sourceMs || targetMs % sourceMs !== 0) {
    throw new RangeError(`aggregate: cannot build ${target} from ${first.interval}`);
  }
  const perBucket = targetMs / sourceMs;

  const buckets = new Map<number, Candle[]>();
  for (const c of series) {
    if (c.interval !== first.interval)
      throw new Error(`aggregate: mixed intervals (${first.interval} vs ${c.interval})`);
    if (c.openTime % sourceMs !== 0)
      throw new Error(`aggregate: misaligned ${c.interval} candle at ${c.openTime}`);
    const start = floorToInterval(c.openTime, targetMs);
    const list = buckets.get(start);
    if (list) list.push(c);
    else buckets.set(start, [c]);
  }

  const out: Candle[] = [];
  for (const [start, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (requireComplete && list.length !== perBucket) continue;
    const head = list[0]!;
    const tail = list[list.length - 1]!;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const c of list) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    out.push({
      venue: head.venue,
      symbol: head.symbol,
      interval: target,
      openTime: start,
      closeTime: start + targetMs - 1,
      open: head.open,
      high,
      low,
      close: tail.close,
      volume,
    });
  }
  return out;
}

/** A run of missing candles. `from`/`to` are the first and last missing openTimes (inclusive). */
export interface Gap {
  from: number;
  to: number;
  missing: number;
}

export interface AlignResult {
  /** Sorted, deduped, aligned candles (plus synthetic fills when `fill` is true). */
  candles: Candle[];
  /** Every run of missing candles between the first and last input candle. */
  gaps: Gap[];
  /** openTimes of synthetic candles inserted by `fill: true`. Empty otherwise. */
  filled: number[];
  /** Candles rejected because their openTime is off-grid or their interval does not match. */
  misaligned: Candle[];
}

export interface AlignOptions {
  /**
   * Insert flat synthetic candles (o=h=l=c=previous close, volume 0) into gaps. Default false.
   * Every synthetic openTime is reported in `filled`; nothing is fabricated silently.
   */
  fill?: boolean;
}

/** Validate grid alignment and detect gaps in a single-venue series. Never fabricates prices silently. */
export function alignAndFill(
  candles: readonly Candle[],
  interval: Interval,
  opts: AlignOptions = {},
): AlignResult {
  const ms = INTERVAL_MS[interval];
  const misaligned: Candle[] = [];
  const good: Candle[] = [];
  for (const c of candles) {
    if (c.interval !== interval || c.openTime % ms !== 0) misaligned.push(c);
    else good.push(c);
  }
  const series = normalizeSeries(good);
  assertSingleVenue(series);

  const out: Candle[] = [];
  const gaps: Gap[] = [];
  const filled: number[] = [];
  let prev: Candle | undefined;
  for (const c of series) {
    if (prev && c.openTime > prev.openTime + ms) {
      const from = prev.openTime + ms;
      const to = c.openTime - ms;
      gaps.push({ from, to, missing: (to - from) / ms + 1 });
      if (opts.fill) {
        for (let t = from; t <= to; t += ms) {
          out.push({
            venue: prev.venue,
            symbol: prev.symbol,
            interval,
            openTime: t,
            closeTime: t + ms - 1,
            open: prev.close,
            high: prev.close,
            low: prev.close,
            close: prev.close,
            volume: 0,
          });
          filled.push(t);
        }
      }
    }
    out.push(c);
    prev = c;
  }
  return { candles: out, gaps, filled, misaligned };
}
