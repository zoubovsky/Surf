import { z } from "zod";
import { Confidence, Direction, PriceLevel, PriceZone, TerminalState } from "./common.js";

/** Researcher output: compact market context. Never opines on direction. */
export const MarketContext = z.object({
  asOf: z.number().int(),
  regime: z.enum(["trending-up", "trending-down", "ranging", "volatile", "unclear"]),
  fundingRateHourly: z.number(),
  fundingAssessment: z.enum(["neutral", "longs-crowded", "shorts-crowded"]),
  openInterestTrend: z.enum(["rising", "falling", "flat", "unknown"]),
  eventRisk: z.array(
    z.object({
      when: z.number().int(),
      description: z.string().max(200),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ).max(10),
  headlines: z.array(z.string().max(200)).max(8),
  brief: z.string().max(1500),
});
export type MarketContext = z.infer<typeof MarketContext>;

export const OrderKind = z.enum(["limit", "market"]);

/** Analyst output. Sizes and leverage are NOT here: code computes them. */
export const TradePlan = z.object({
  action: z.enum(["enter", "hold", "exit", "adjust-stop", "no-trade"]),
  direction: Direction.nullable(),
  /** Which EW candidate id this plan is built on. */
  candidateId: z.string().nullable(),
  /** Which analyst prior (video) supported it, if any. */
  priorVideoId: z.string().nullable(),
  setup: z.enum(["wave-2-end", "wave-4-end", "wave-c-end", "wave-b-end", "other"]).nullable(),
  entry: PriceZone.nullable(),
  entryKind: OrderKind.nullable(),
  stopLoss: PriceLevel.nullable(),
  takeProfit: PriceLevel.nullable(),
  /** New stop when action = adjust-stop. */
  newStop: PriceLevel.nullable(),
  expectedHoldHours: z.number().positive().max(24 * 14).nullable(),
  confidence: Confidence,
  /** Every claim must cite an evidence id: candidate id, video id, indicator name, or headline index. */
  evidence: z.array(z.string().max(200)).max(20),
  /** True if the analyst prior materially disagrees with the deterministic count. */
  priorDisagrees: z.boolean(),
  rationale: z.string().max(2000),
});
export type TradePlan = z.infer<typeof TradePlan>;

/** Independent reviewer verdict. */
export const ReviewVerdict = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  /** Reviewer may lower confidence, never raise it. */
  adjustedConfidence: Confidence,
  reasons: z.array(z.string().max(300)).min(1).max(12),
  /** Checks the reviewer performed, for the audit log. */
  checks: z.object({
    dataFresh: z.boolean(),
    evidenceTraceable: z.boolean(),
    stopBeyondInvalidation: z.boolean(),
    rewardRiskRecomputed: z.number().nullable(),
    priorConsistent: z.boolean(),
    stateConsistent: z.boolean(),
  }),
  severity: z.enum(["none", "minor", "major"]),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** Snapshot of the exchange account, from code, never from a model. */
export const AccountSnapshot = z.object({
  asOf: z.number().int(),
  equity: z.number().nonnegative(),
  availableBalance: z.number().nonnegative(),
  openPositions: z.array(
    z.object({
      symbol: z.string(),
      direction: Direction,
      size: z.number().positive(),
      entryPrice: z.number().positive(),
      leverage: z.number().positive(),
      liquidationPrice: z.number().positive().nullable(),
      unrealizedPnl: z.number(),
    }),
  ),
  openOrders: z.number().int().nonnegative(),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshot>;

/** Snapshot of the market, from code. */
export const MarketSnapshot = z.object({
  asOf: z.number().int(),
  symbol: z.string(),
  markPrice: z.number().positive(),
  indexPrice: z.number().positive(),
  referencePrice: z.number().positive().nullable(),
  bestBid: z.number().positive().nullable(),
  bestAsk: z.number().positive().nullable(),
  /** Visible notional (USD) within 0.5% of mid on the side we would take. */
  depthNotionalNear: z.number().nonnegative().nullable(),
  fundingRateHourly: z.number(),
  nextFundingTime: z.number().int().nullable(),
  lastCandleCloseTime: z.number().int().nullable(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

/** Rolling trading state used by the risk engine. */
export const TradingState = z.object({
  tradingMode: z.enum(["shadow", "live"]),
  paused: z.boolean(),
  halted: z.boolean(),
  haltReason: z.string().nullable(),
  haltedAt: z.number().int().nullable(),
  dayStartEquity: z.number().nonnegative(),
  highWaterEquity: z.number().nonnegative(),
  entriesToday: z.number().int().nonnegative(),
  lastEntryAt: z.number().int().nullable(),
  consecutiveStopOuts: z.number().int().nonnegative(),
  llmSpendTodayUsd: z.number().nonnegative(),
});
export type TradingState = z.infer<typeof TradingState>;

/** Hard limits. Config only. No model can read or write these at runtime. */
export const RiskLimits = z.object({
  riskPerTradePct: z.number().positive().max(2).default(1),
  maxLeverage: z.number().positive().max(20).default(5),
  maxConcurrentPositions: z.number().int().positive().default(1),
  maxDailyLossPct: z.number().positive().default(3),
  maxDrawdownPct: z.number().positive().default(10),
  maxEntriesPerDay: z.number().int().positive().default(4),
  minHoursBetweenEntries: z.number().nonnegative().default(2),
  maxDepthFraction: z.number().positive().max(1).default(0.1),
  minRewardRisk: z.number().positive().default(2),
  maxStopDistancePct: z.number().positive().default(6),
  minStopDistancePct: z.number().positive().default(0.3),
  maxCandleAgeMs: z.number().positive().default(2 * 3_600_000),
  maxReferenceDeviationPct: z.number().positive().default(1),
  maxConsecutiveStopOuts: z.number().int().positive().default(3),
  haltCooldownHours: z.number().positive().default(24),
  dailyLlmBudgetUsd: z.number().positive().default(10),
  minConfidenceToTrade: Confidence.default("high"),
  /** Extreme adverse funding (per hour) above which new entries against it are refused. */
  maxAdverseFundingHourly: z.number().positive().default(0.0005),
  /** Minimum position notional accepted by the venue. */
  minNotionalUsd: z.number().positive().default(10),
  /** Contract step size. */
  sizeStep: z.number().positive().default(0.00001),
  priceTick: z.number().positive().default(0.1),
});
export type RiskLimits = z.infer<typeof RiskLimits>;

export const RiskCheck = z.object({
  rule: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type RiskCheck = z.infer<typeof RiskCheck>;

/** Sized order the executor may place. Produced only by the risk engine. */
export const SizedOrder = z.object({
  symbol: z.string(),
  direction: Direction,
  entryKind: OrderKind,
  entryPrice: z.number().positive(),
  size: z.number().positive(),
  notionalUsd: z.number().positive(),
  leverage: z.number().positive(),
  marginUsd: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  riskUsd: z.number().positive(),
  rewardRisk: z.number().positive(),
  expectedFundingUsd: z.number(),
});
export type SizedOrder = z.infer<typeof SizedOrder>;

export const RiskDecision = z.object({
  verdict: z.enum(["allow", "deny"]),
  planHash: z.string(),
  checks: z.array(RiskCheck),
  order: SizedOrder.nullable(),
  terminal: TerminalState,
  summary: z.string(),
});
export type RiskDecision = z.infer<typeof RiskDecision>;
