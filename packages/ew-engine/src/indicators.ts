import type { Candle, Swing } from "@surf/core";
import { at } from "./util.js";

export type Divergence = "bullish" | "bearish" | "none";

/**
 * Wilder RSI. Output is aligned with `closes`; the first `period` entries are `null`.
 * Flat markets (no gains and no losses) return 50; no losses returns 100.
 */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  if (period <= 0 || closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = at(closes, i) - at(closes, i - 1);
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = at(closes, i) - at(closes, i - 1);
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True range of candle `i` (uses the previous close when available). */
export function trueRange(candles: readonly Candle[], i: number): number {
  const c = at(candles, i);
  if (i === 0) return c.high - c.low;
  const pc = at(candles, i - 1).close;
  return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
}

/**
 * Wilder ATR (TA-Lib convention): first value at index `period` is the mean of TR[1..period],
 * then smoothed. Output is aligned with `candles`; warm-up entries are `null`.
 */
export function atr(candles: readonly Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(candles.length).fill(null);
  if (period <= 0 || candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(candles, i);
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + trueRange(candles, i)) / period;
    out[i] = value;
  }
  return out;
}

/**
 * Causal ATR-like volatility estimate that is defined for every index: Wilder ATR once it is
 * available, otherwise the expanding mean of true ranges seen so far. Never looks ahead.
 */
export function atrWithWarmup(candles: readonly Candle[], period = 14): number[] {
  const a = atr(candles, period);
  const out: number[] = new Array<number>(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const v = a[i];
    if (v !== null && v !== undefined) {
      out[i] = v;
      continue;
    }
    const tr = trueRange(candles, i);
    sum += tr;
    out[i] = sum / (i + 1);
  }
  return out;
}

function rsiAt(series: readonly (number | null)[], index: number): number | null {
  const v = series[index];
  return v === undefined ? null : v;
}

/**
 * Divergence between two pivots of the same kind. `a` is the earlier pivot.
 * Bearish: higher high in price with lower RSI. Bullish: lower low in price with higher RSI.
 */
export function divergenceBetween(
  a: Pick<Swing, "index" | "price" | "kind">,
  b: Pick<Swing, "index" | "price" | "kind">,
  rsiSeries: readonly (number | null)[],
): Divergence {
  if (a.kind !== b.kind) return "none";
  const ra = rsiAt(rsiSeries, a.index);
  const rb = rsiAt(rsiSeries, b.index);
  if (ra === null || rb === null) return "none";
  if (a.kind === "high" && b.price > a.price && rb < ra) return "bearish";
  if (a.kind === "low" && b.price < a.price && rb > ra) return "bullish";
  return "none";
}

/**
 * RSI divergence over the last two swing highs and the last two swing lows.
 * When both a bullish and a bearish divergence are present, the one whose later pivot is
 * more recent wins.
 */
export function rsiDivergence(swings: readonly Swing[], rsiSeries: readonly (number | null)[]): Divergence {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  let bearishAt = -1;
  let bullishAt = -1;
  if (highs.length >= 2) {
    const a = at(highs, highs.length - 2);
    const b = at(highs, highs.length - 1);
    if (divergenceBetween(a, b, rsiSeries) === "bearish") bearishAt = b.index;
  }
  if (lows.length >= 2) {
    const a = at(lows, lows.length - 2);
    const b = at(lows, lows.length - 1);
    if (divergenceBetween(a, b, rsiSeries) === "bullish") bullishAt = b.index;
  }
  if (bearishAt < 0 && bullishAt < 0) return "none";
  return bearishAt >= bullishAt ? "bearish" : "bullish";
}
