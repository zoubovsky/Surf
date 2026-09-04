import { z } from "zod";

/** Direction of a trade or thesis. */
export const Direction = z.enum(["long", "short"]);
export type Direction = z.infer<typeof Direction>;

/** Confidence buckets used everywhere a model states confidence. */
export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Supported candle intervals. */
export const Interval = z.enum(["1h", "4h", "1d"]);
export type Interval = z.infer<typeof Interval>;

export const INTERVAL_MS: Record<Interval, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** A closed OHLCV candle. Times are Unix ms. Prices are numbers (USD). */
export const Candle = z.object({
  venue: z.string(),
  symbol: z.string(),
  interval: Interval,
  openTime: z.number().int(),
  closeTime: z.number().int(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
});
export type Candle = z.infer<typeof Candle>;

/** Named terminal states for every loop run. "exhausted" and "blocked" are never success. */
export const TerminalState = z.enum([
  "traded",
  "resting-placed",
  "hold",
  "no-op",
  "ingested",
  "not-relevant",
  "transcript-unavailable",
  "reviewed",
  "applied",
  "rejected",
  "blocked",
  "exhausted",
  "failed",
]);
export type TerminalState = z.infer<typeof TerminalState>;

/** A price level with a reason, used for invalidation, targets and zones. */
export const PriceLevel = z.object({
  price: z.number().positive(),
  label: z.string().max(120),
});
export type PriceLevel = z.infer<typeof PriceLevel>;

export const PriceZone = z.object({
  low: z.number().positive(),
  high: z.number().positive(),
  label: z.string().max(120),
});
export type PriceZone = z.infer<typeof PriceZone>;
