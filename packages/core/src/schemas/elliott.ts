import { z } from "zod";
import { Confidence, Direction, Interval, PriceLevel, PriceZone } from "./common.js";

/** A confirmed swing pivot from the ZigZag layer. */
export const Swing = z.object({
  index: z.number().int().nonnegative(),
  time: z.number().int(),
  price: z.number().positive(),
  kind: z.enum(["high", "low"]),
});
export type Swing = z.infer<typeof Swing>;

export const WavePattern = z.enum(["impulse", "diagonal", "zigzag", "flat", "triangle"]);
export type WavePattern = z.infer<typeof WavePattern>;

/** Where price currently sits inside the candidate structure. */
export const WavePosition = z.enum([
  "in-wave-1",
  "in-wave-2",
  "in-wave-3",
  "in-wave-4",
  "in-wave-5",
  "in-wave-a",
  "in-wave-b",
  "in-wave-c",
  "complete",
]);
export type WavePosition = z.infer<typeof WavePosition>;

/** A rule-valid wave count with deterministic invalidation and targets. */
export const EwCandidate = z.object({
  id: z.string(),
  interval: Interval,
  pattern: WavePattern,
  /** Direction of the larger-degree move this count implies next. */
  direction: Direction,
  position: WavePosition,
  pivots: z.array(Swing).min(2),
  /** Price at which this count is invalidated by the hard rules. */
  invalidation: PriceLevel,
  targets: z.array(PriceZone),
  /** Fib-zone where an entry in `direction` is favourable, if the count is at a tradable point. */
  entryZone: PriceZone.nullable(),
  /** 0..1 deterministic score from guidelines (Fib ratios, alternation, momentum). */
  score: z.number().min(0).max(1),
  hardRulesPassed: z.literal(true),
  notes: z.array(z.string().max(200)),
});
export type EwCandidate = z.infer<typeof EwCandidate>;

/** Output of the deterministic engine for one interval at one point in time. */
export const EwAnalysis = z.object({
  symbol: z.string(),
  interval: Interval,
  asOf: z.number().int(),
  lastClose: z.number().positive(),
  swings: z.array(Swing),
  candidates: z.array(EwCandidate),
  /** Momentum context for confluence scoring. */
  momentum: z.object({
    rsi14: z.number().min(0).max(100).nullable(),
    rsiDivergence: z.enum(["bullish", "bearish", "none"]),
    atr14: z.number().nonnegative().nullable(),
  }),
});
export type EwAnalysis = z.infer<typeof EwAnalysis>;

/**
 * Structured thesis extracted from a More Crypto Online video transcript.
 * Every level must be supported by a quoted evidence span from the transcript.
 */
export const AnalystPrior = z.object({
  videoId: z.string(),
  publishedAt: z.number().int(),
  title: z.string(),
  asset: z.literal("BTC"),
  bias: Direction.nullable(),
  timeframe: z.string().max(80),
  primaryCount: z.string().max(400),
  alternateCount: z.string().max(400).nullable(),
  keyLevels: z.array(PriceLevel).max(12),
  invalidation: PriceLevel.nullable(),
  targets: z.array(PriceLevel).max(8),
  entryZone: PriceZone.nullable(),
  confidence: Confidence,
  /** Verbatim transcript snippets supporting the extracted levels. */
  evidence: z.array(z.string().max(400)).min(1).max(12),
  summary: z.string().max(1200),
});
export type AnalystPrior = z.infer<typeof AnalystPrior>;
