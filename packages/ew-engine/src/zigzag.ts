import type { Candle, Swing } from "@surf/core";
import { atrWithWarmup } from "./indicators.js";
import { at } from "./util.js";

export interface ZigZagOptions {
  /** Reversal threshold in ATR multiples. Larger = coarser degree. Default 3. */
  k?: number;
  /** ATR period. Default 14. */
  atrPeriod?: number;
}

export interface ZigZagResult {
  /** ATR multiple used. */
  k: number;
  /** Pivots whose reversal has been confirmed, strictly alternating high/low. */
  confirmed: Swing[];
  /**
   * Extreme of the current (unconfirmed) leg, always of the opposite kind to the last confirmed
   * pivot. `null` when no direction has been established yet.
   */
  provisional: Swing | null;
  /** +1 while the current leg is rising, -1 while falling, 0 before the first reversal. */
  trend: 1 | -1 | 0;
}

/**
 * ATR-scaled ZigZag. A reversal is confirmed when price moves against the current leg's extreme
 * by more than `k × ATR(atrPeriod)` at that bar. While a leg extends to a new extreme, the
 * provisional pivot is replaced. Fully causal: a pivot confirmed at bar i depends only on bars
 * ≤ i, so appending candles never rewrites earlier confirmed pivots.
 *
 * During ATR warm-up the threshold uses the expanding mean of true ranges seen so far.
 */
export function zigzagDetailed(candles: readonly Candle[], opts: ZigZagOptions = {}): ZigZagResult {
  const k = opts.k ?? 3;
  const period = opts.atrPeriod ?? 14;
  if (!(k > 0)) throw new RangeError(`zigzag: k must be > 0 (got ${k})`);
  const n = candles.length;
  const confirmed: Swing[] = [];
  if (n === 0) return { k, confirmed, provisional: null, trend: 0 };

  const vol = atrWithWarmup(candles, period);
  const thr = (i: number): number => k * at(vol, i);

  let trend: 1 | -1 | 0 = 0;
  const first = at(candles, 0);
  let maxHi = first.high;
  let maxHiIdx = 0;
  let minLo = first.low;
  let minLoIdx = 0;

  const pivot = (idx: number, price: number, kind: "high" | "low"): Swing => ({
    index: idx,
    time: at(candles, idx).openTime,
    price,
    kind,
  });

  for (let i = 0; i < n; i++) {
    const c = at(candles, i);
    if (trend === 0) {
      if (c.high > maxHi) {
        maxHi = c.high;
        maxHiIdx = i;
      }
      if (c.low < minLo) {
        minLo = c.low;
        minLoIdx = i;
      }
      const t = thr(i);
      const upMove = c.high - minLo;
      const downMove = maxHi - c.low;
      if (upMove > t && (downMove <= t || minLoIdx <= maxHiIdx)) {
        // First pivot is the low; we are now in an up leg.
        confirmed.push(pivot(minLoIdx, minLo, "low"));
        trend = 1;
        ({ price: maxHi, idx: maxHiIdx } = extremeAfter(candles, minLoIdx, i, "high"));
      } else if (downMove > t) {
        confirmed.push(pivot(maxHiIdx, maxHi, "high"));
        trend = -1;
        ({ price: minLo, idx: minLoIdx } = extremeAfter(candles, maxHiIdx, i, "low"));
      }
      continue;
    }

    if (trend === 1) {
      if (c.high > maxHi) {
        maxHi = c.high;
        maxHiIdx = i;
      }
      if (maxHi - c.low > thr(i)) {
        confirmed.push(pivot(maxHiIdx, maxHi, "high"));
        trend = -1;
        minLo = c.low;
        minLoIdx = i;
      }
    } else {
      if (c.low < minLo) {
        minLo = c.low;
        minLoIdx = i;
      }
      if (c.high - minLo > thr(i)) {
        confirmed.push(pivot(minLoIdx, minLo, "low"));
        trend = 1;
        maxHi = c.high;
        maxHiIdx = i;
      }
    }
  }

  let provisional: Swing | null = null;
  if (trend === 1) provisional = pivot(maxHiIdx, maxHi, "high");
  else if (trend === -1) provisional = pivot(minLoIdx, minLo, "low");
  return { k, confirmed, provisional, trend };
}

/** Confirmed ZigZag pivots only. */
export function zigzag(candles: readonly Candle[], opts: ZigZagOptions = {}): Swing[] {
  return zigzagDetailed(candles, opts).confirmed;
}

/** Run the ZigZag at several degrees (ATR multiples), coarsest last. */
export function zigzagDegrees(
  candles: readonly Candle[],
  ks: readonly number[],
  atrPeriod = 14,
): ZigZagResult[] {
  return [...ks].sort((a, b) => a - b).map((k) => zigzagDetailed(candles, { k, atrPeriod }));
}

function extremeAfter(
  candles: readonly Candle[],
  fromExclusive: number,
  toInclusive: number,
  kind: "high" | "low",
): { price: number; idx: number } {
  let idx = Math.min(fromExclusive + 1, toInclusive);
  let price = kind === "high" ? at(candles, idx).high : at(candles, idx).low;
  for (let j = idx + 1; j <= toInclusive; j++) {
    const c = at(candles, j);
    if (kind === "high" ? c.high > price : c.low < price) {
      price = kind === "high" ? c.high : c.low;
      idx = j;
    }
  }
  return { price, idx };
}
