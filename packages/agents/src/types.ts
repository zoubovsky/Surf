import { z } from "zod";
import { Confidence, Direction, PriceLevel, PriceZone, RiskLimits } from "@surf/core";

/** Haiku triage verdict for a new video. */
export const TriageResult = z.object({
  /** About Bitcoin price action at all. */
  relevant: z.boolean(),
  /** Primarily Bitcoin technical / Elliott Wave analysis (not news, altcoins, or general macro). */
  isBitcoinAnalysis: z.boolean(),
  /** Contains specific counts, levels, invalidations or targets rather than generic commentary. */
  substantive: z.boolean(),
  reason: z.string().max(300),
});
export type TriageResult = z.infer<typeof TriageResult>;

export const ExtractPriorInput = z.object({
  videoId: z.string(),
  title: z.string(),
  publishedAt: z.number().int(),
  transcriptText: z.string().min(1),
  /** Caller-selected transcript excerpts around keywords (invalidation, target, wave ...). */
  keywordWindows: z.array(z.string()).max(40).default([]),
});
export type ExtractPriorInput = z.infer<typeof ExtractPriorInput>;
export type ExtractPriorInputRaw = z.input<typeof ExtractPriorInput>;

/** Report of the deterministic evidence check run after extraction. */
export const EvidenceReport = z.object({
  evidenceChecked: z.number().int(),
  evidenceDropped: z.array(z.string()),
  levelsDropped: z.array(z.object({ field: z.string(), price: z.number(), label: z.string() })),
  confidenceLowered: z.boolean(),
});
export type EvidenceReport = z.infer<typeof EvidenceReport>;

export const FundingPoint = z.object({ time: z.number().int(), rateHourly: z.number() });
export const OpenInterestPoint = z.object({ time: z.number().int(), openInterestUsd: z.number().nonnegative() });
export const CalendarEvent = z.object({
  when: z.number().int(),
  title: z.string().max(200),
  importance: z.enum(["low", "medium", "high"]),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const Headline = z.object({
  source: z.string().max(80),
  publishedAt: z.number().int().nullable(),
  title: z.string().max(300),
});
export type Headline = z.infer<typeof Headline>;

/** Calibration ledger snapshot, computed by code from closed trades. */
const Bucket = z.object({
  n: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
  brier: z.number().min(0).max(1).nullable(),
  avgR: z.number().nullable(),
});
export const CalibrationSummary = z.object({
  asOf: z.number().int(),
  closedTrades: z.number().int().nonnegative(),
  byConfidence: z.object({ low: Bucket, medium: Bucket, high: Bucket }),
  bySetup: z.record(z.string(), Bucket),
  /** How often the MCO primary count's direction played out. */
  priorAccuracy: Bucket.nullable(),
  /** How often our own top candidate's direction played out. */
  ownCountAccuracy: Bucket.nullable(),
});
export type CalibrationSummary = z.infer<typeof CalibrationSummary>;

/** Journal context for a position that is currently open. */
export const OpenPositionContext = z.object({
  tradeId: z.string(),
  openedAt: z.number().int(),
  direction: Direction,
  entryPrice: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  candidateId: z.string().nullable(),
  priorVideoId: z.string().nullable(),
  thesis: z.string().max(1000),
});
export type OpenPositionContext = z.infer<typeof OpenPositionContext>;

/** Trade journal entry written at entry time (never edited afterwards). */
export const JournalEntry = z.object({
  tradeId: z.string(),
  openedAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  direction: Direction,
  setup: z.enum(["wave-2-end", "wave-4-end", "wave-c-end", "wave-b-end", "other"]).nullable(),
  candidateId: z.string().nullable(),
  priorVideoId: z.string().nullable(),
  entryZone: PriceZone.nullable(),
  entryKind: z.enum(["limit", "market"]).nullable(),
  filledPrice: z.number().positive().nullable(),
  stopLoss: PriceLevel,
  takeProfit: PriceLevel,
  invalidation: PriceLevel.nullable(),
  analystConfidence: Confidence,
  reviewerConfidence: Confidence,
  reviewerReasons: z.array(z.string()).max(12),
  priorDisagrees: z.boolean(),
  rationale: z.string().max(2000),
  evidence: z.array(z.string()).max(20),
  paramsVersion: z.string(),
  knowledgeVersion: z.string().nullable(),
  modelIds: z.record(z.string(), z.string()),
  promptHashes: z.record(z.string(), z.string()),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/** Outcome facts computed by code. The model never computes PnL. */
export const OutcomeFacts = z.object({
  tradeId: z.string(),
  realizedR: z.number(),
  realizedPnlUsd: z.number(),
  maeR: z.number().nonnegative(),
  mfeR: z.number().nonnegative(),
  holdHours: z.number().nonnegative(),
  feesUsd: z.number(),
  fundingUsd: z.number(),
  slippageBps: z.number().nullable(),
  exitReason: z.enum(["stop", "target", "invalidation-flatten", "trailing-stop", "breakeven-stop", "manual", "expired", "halt"]),
  hitFirst: z.enum(["invalidation", "target", "neither"]),
  /** Bars the primary count survived after entry before being invalidated (null = still valid at close). */
  countSurvivedBars: z.number().int().nonnegative().nullable(),
});
export type OutcomeFacts = z.infer<typeof OutcomeFacts>;

export const FailureMode = z.enum([
  "wrong-count",
  "premature-entry",
  "entry-zone-missed",
  "stop-too-tight",
  "stop-too-wide",
  "target-too-ambitious",
  "ignored-context",
  "prior-overweighted",
  "prior-underweighted",
  "execution-slippage",
  "funding-drag",
  "stale-data",
  "process-violation",
  "bad-luck",
  "unknown",
]);
export type FailureMode = z.infer<typeof FailureMode>;

export const PostTradeReviewOutput = z.object({
  /** Quality of the decision given what was knowable at entry, independent of outcome. */
  decisionQuality: z.enum(["good", "acceptable", "poor"]),
  outcome: z.enum(["win", "loss", "scratch"]),
  failureMode: FailureMode.nullable(),
  lesson: z
    .object({
      text: z.string().max(400),
      evidenceTradeIds: z.array(z.string()).min(1).max(10),
    })
    .nullable(),
  summary: z.string().max(800),
});
export type PostTradeReviewOutput = z.infer<typeof PostTradeReviewOutput>;

export const PostTradeReviewInput = z.object({
  journalEntry: JournalEntry,
  outcomeFacts: OutcomeFacts,
  /** Prior lessons currently active, so the reviewer proposes something new or nothing. */
  activeLessons: z.array(z.string().max(400)).max(20).default([]),
});
export type PostTradeReviewInput = z.infer<typeof PostTradeReviewInput>;
export type PostTradeReviewInputRaw = z.input<typeof PostTradeReviewInput>;

export const DailyBriefInput = z.object({
  asOf: z.number().int(),
  timezone: z.string(),
  positions: z.array(
    z.object({
      direction: Direction,
      size: z.number(),
      entryPrice: z.number(),
      markPrice: z.number(),
      unrealizedPnlUsd: z.number(),
      stopLoss: z.number().nullable(),
      takeProfit: z.number().nullable(),
    }),
  ),
  restingOrders: z.array(
    z.object({ direction: Direction, price: z.number(), stopLoss: z.number(), takeProfit: z.number(), expiresAt: z.number().int().nullable() }),
  ),
  pnl: z.object({ todayUsd: z.number(), d7Usd: z.number(), d30Usd: z.number(), equityUsd: z.number() }),
  latestPrior: z
    .object({ title: z.string(), publishedAt: z.number().int(), bias: Direction.nullable(), primaryCount: z.string(), invalidation: z.number().nullable() })
    .nullable(),
  ownCount: z.array(z.object({ id: z.string(), interval: z.string(), direction: Direction, position: z.string(), invalidation: z.number(), score: z.number() })),
  regime: z.object({ regime: z.string(), fundingRateHourly: z.number(), fundingAssessment: z.string(), openInterestTrend: z.string() }),
  events: z.array(z.object({ when: z.number().int(), description: z.string(), severity: z.string() })).max(10),
  calibration: CalibrationSummary.nullable(),
  llmSpend: z.object({ todayUsd: z.number(), budgetUsd: z.number() }),
  health: z.object({ tradingMode: z.string(), paused: z.boolean(), halted: z.boolean(), haltReason: z.string().nullable(), lastError: z.string().nullable() }),
});
export type DailyBriefInput = z.infer<typeof DailyBriefInput>;

export const AnswerQuestionInput = z.object({
  question: z.string().min(1).max(2000),
  context: z.object({
    asOf: z.number().int(),
    positions: z.array(z.record(z.string(), z.unknown())),
    pnl: z.record(z.string(), z.number()),
    recentDecisions: z
      .array(
        z.object({
          at: z.number().int(),
          action: z.string(),
          direction: Direction.nullable(),
          candidateId: z.string().nullable(),
          reviewerVerdict: z.string().nullable(),
          terminal: z.string(),
          summary: z.string().max(600),
        }),
      )
      .max(30),
    limits: RiskLimits,
  }),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

/** One LLM stage as journaled by the orchestrator. */
export const StageRecord = z.object({
  stage: z.enum(["research", "analyze", "review"]),
  round: z.number().int().nonnegative(),
  model: z.string(),
  promptHash: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    cachedReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  }),
  durationMs: z.number(),
  output: z.unknown(),
});
export type StageRecord = z.infer<typeof StageRecord>;
