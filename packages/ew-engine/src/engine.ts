import { EwAnalysis, INTERVAL_MS } from "@surf/core";
import type { Candle } from "@surf/core";
import { enumerateCandidates } from "./candidates.js";
import { atr, rsi, rsiDivergence } from "./indicators.js";
import { at, clamp01, last, round } from "./util.js";
import { zigzagDegrees } from "./zigzag.js";

export const DEFAULT_KS: readonly number[] = [1.5, 3, 6];

export interface AnalyzeOptions {
  /** ZigZag degrees as ATR multiples. Default [1.5, 3, 6]. */
  ks?: readonly number[];
  /** Default 14. */
  atrPeriod?: number;
  /** Default 14. */
  rsiPeriod?: number;
  /** Candidates returned. Default 5. */
  topK?: number;
  /** Recent pivots per degree considered. Default 9. */
  maxPivots?: number;
  /** Which degree's confirmed pivots populate `swings`. Default: the middle entry of `ks`. */
  swingsK?: number;
}

/**
 * Analyse one interval of candles. Pure and deterministic; validates its output against the core
 * `EwAnalysis` schema. Throws only on empty input or non-positive prices (schema violation).
 */
export function analyze(candles: readonly Candle[], opts: AnalyzeOptions = {}): EwAnalysis {
  if (candles.length === 0) throw new Error("analyze: at least one candle is required");
  const lastCandle = last(candles);
  const interval = lastCandle.interval;
  const ks = opts.ks && opts.ks.length > 0 ? [...opts.ks].sort((a, b) => a - b) : [...DEFAULT_KS];
  const atrPeriod = opts.atrPeriod ?? 14;
  const rsiPeriod = opts.rsiPeriod ?? 14;

  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, rsiPeriod);
  const atrSeries = atr(candles, atrPeriod);
  const degrees = zigzagDegrees(candles, ks, atrPeriod);

  const swingsK = opts.swingsK ?? at(ks, Math.floor((ks.length - 1) / 2));
  const primary = degrees.find((d) => d.k === swingsK) ?? at(degrees, 0);
  const swings = primary.confirmed;
  const divergenceSwings = primary.provisional ? [...swings, primary.provisional] : swings;

  const candidates = enumerateCandidates(
    degrees,
    { interval, lastClose: lastCandle.close, rsi: rsiSeries, intervalMs: INTERVAL_MS[interval] },
    { topK: opts.topK ?? 5, maxPivots: opts.maxPivots ?? 9 },
  );

  const lastRsi = last(rsiSeries);
  const lastAtr = last(atrSeries);
  const analysis: EwAnalysis = {
    symbol: lastCandle.symbol,
    interval,
    asOf: lastCandle.closeTime,
    lastClose: lastCandle.close,
    swings,
    candidates,
    momentum: {
      rsi14: lastRsi === null ? null : round(lastRsi, 4),
      rsiDivergence: rsiDivergence(divergenceSwings, rsiSeries),
      atr14: lastAtr === null ? null : round(lastAtr, 6),
    },
  };
  return EwAnalysis.parse(analysis);
}

export interface MultiInput {
  h1: readonly Candle[];
  h4: readonly Candle[];
}

export interface MultiOptions extends AnalyzeOptions {
  /** Score adjustment applied to 1h candidates for agreement/conflict with the top 4h candidate. Default 0.1. */
  boost?: number;
}

export interface MultiResult {
  h1: EwAnalysis;
  h4: EwAnalysis;
  /** Direction of the top 4h candidate, if any. */
  h4Direction: "long" | "short" | null;
}

/**
 * Analyse 1h and 4h together. 1h candidates whose direction agrees with the top 4h candidate get
 * `+boost`, conflicting ones `-boost`; the 1h list is then re-sorted and truncated to `topK`.
 * The 4h analysis is returned unchanged.
 */
export function analyzeMulti(input: MultiInput, opts: MultiOptions = {}): MultiResult {
  const boost = opts.boost ?? 0.1;
  const topK = opts.topK ?? 5;
  const h4 = analyze(input.h4, opts);
  const wide = analyze(input.h1, { ...opts, topK: Math.max(topK * 3, 15) });
  const top4 = h4.candidates[0];
  if (!top4) {
    const h1 = EwAnalysis.parse({ ...wide, candidates: wide.candidates.slice(0, topK) });
    return { h1, h4, h4Direction: null };
  }
  const adjusted = wide.candidates.map((c) => {
    const agrees = c.direction === top4.direction;
    const delta = agrees ? boost : -boost;
    const note = agrees
      ? `4h top candidate (${top4.pattern} ${top4.position}, ${top4.direction}) agrees: +${boost}`
      : `4h top candidate (${top4.pattern} ${top4.position}, ${top4.direction}) conflicts: -${boost}`;
    return { ...c, score: round(clamp01(c.score + delta), 4), notes: [...c.notes, note] };
  });
  adjusted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const h1 = EwAnalysis.parse({ ...wide, candidates: adjusted.slice(0, topK) });
  return { h1, h4, h4Direction: top4.direction };
}
