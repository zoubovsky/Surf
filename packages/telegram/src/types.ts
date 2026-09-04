import { z } from "zod";
import type { AccountSnapshot, MarketSnapshot } from "@surf/core";

/**
 * Report types the daemon hands to the Telegram layer. Everything here is owned by
 * `@surf/telegram`; core schemas (AccountSnapshot, EwAnalysis, ...) are referenced by type only
 * so this package has no runtime dependency on a built `@surf/core`.
 */

export const PnlRange = z.enum(["today", "7d", "30d", "all"]);
export type PnlRange = z.infer<typeof PnlRange>;

export const Health = z.enum(["ok", "degraded", "down", "unknown"]);
export type Health = z.infer<typeof Health>;

/** One closed trade row for the PnL table. */
export const PnlTradeRow = z.object({
  tradeId: z.string(),
  closedAt: z.number().int(),
  direction: z.enum(["long", "short"]),
  setup: z.string().nullable(),
  realizedUsd: z.number(),
  realizedR: z.number().nullable(),
});
export type PnlTradeRow = z.infer<typeof PnlTradeRow>;

export const PnlReport = z.object({
  range: PnlRange,
  asOf: z.number().int(),
  /** Window start (Unix ms) actually used by the daemon. */
  from: z.number().int(),
  startEquity: z.number().nonnegative(),
  endEquity: z.number().nonnegative(),
  realizedUsd: z.number(),
  unrealizedUsd: z.number(),
  feesUsd: z.number(),
  fundingUsd: z.number(),
  /** realized + unrealized - fees + funding (funding is signed: paid negative). */
  netUsd: z.number(),
  /** Net as a percentage of startEquity. */
  netPct: z.number(),
  maxDrawdownPct: z.number().nonnegative(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  avgR: z.number().nullable(),
  bestR: z.number().nullable(),
  worstR: z.number().nullable(),
  /** Most recent closed trades first. The formatter shows at most 10. */
  rows: z.array(PnlTradeRow),
});
export type PnlReport = z.infer<typeof PnlReport>;

export const OrderRole = z.enum(["entry", "stop-loss", "take-profit", "exit", "other"]);
export type OrderRole = z.infer<typeof OrderRole>;

export const OpenOrderView = z.object({
  orderId: z.string(),
  tradeId: z.string().nullable(),
  symbol: z.string(),
  role: OrderRole,
  /** Order side as the venue sees it. */
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market", "stop", "stop-limit", "take-profit"]),
  price: z.number().positive().nullable(),
  triggerPrice: z.number().positive().nullable(),
  size: z.number().positive(),
  filledSize: z.number().nonnegative().default(0),
  reduceOnly: z.boolean().default(false),
  status: z.string(),
  createdAt: z.number().int(),
});
export type OpenOrderView = z.infer<typeof OpenOrderView>;

/** Composite for `/positions`; account and market come straight from core snapshots. */
export interface PositionsView {
  account: AccountSnapshot;
  market: MarketSnapshot;
  orders: OpenOrderView[];
}

export const FeedHealth = z.object({
  name: z.string(),
  health: Health,
  lastEventAt: z.number().int().nullable(),
  detail: z.string().nullable().default(null),
});
export type FeedHealth = z.infer<typeof FeedHealth>;

export const StatusReport = z.object({
  asOf: z.number().int(),
  mode: z.enum(["shadow", "live"]),
  paused: z.boolean(),
  halted: z.boolean(),
  haltReason: z.string().nullable(),
  haltedAt: z.number().int().nullable(),
  /** Process start time (Unix ms). */
  startedAt: z.number().int(),
  symbol: z.string(),
  lastCandleCloseTime: z.number().int().nullable(),
  lastCycleAt: z.number().int().nullable(),
  lastCycleTerminal: z.string().nullable(),
  feeds: z.array(FeedHealth),
  lastError: z
    .object({
      at: z.number().int(),
      context: z.string(),
      message: z.string(),
    })
    .nullable(),
  llmSpendTodayUsd: z.number().nonnegative(),
  llmBudgetUsd: z.number().positive(),
  openPositions: z.number().int().nonnegative(),
  openOrders: z.number().int().nonnegative(),
  entriesToday: z.number().int().nonnegative(),
  consecutiveStopOuts: z.number().int().nonnegative(),
  version: z.string().nullable().default(null),
});
export type StatusReport = z.infer<typeof StatusReport>;

export const TradeEvent = z.object({
  at: z.number().int(),
  kind: z.string(),
  detail: z.string(),
});
export type TradeEvent = z.infer<typeof TradeEvent>;

/** Stored rationale for `/why <tradeId>`. */
export const TradeExplanation = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  direction: z.enum(["long", "short"]),
  setup: z.string().nullable(),
  candidateId: z.string().nullable(),
  priorVideoId: z.string().nullable(),
  openedAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  entryPrice: z.number().positive(),
  size: z.number().positive(),
  leverage: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  exitPrice: z.number().positive().nullable(),
  realizedUsd: z.number().nullable(),
  realizedR: z.number().nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  reviewVerdict: z.enum(["approve", "revise", "reject"]),
  reviewReasons: z.array(z.string()),
  riskSummary: z.string(),
  evidence: z.array(z.string()),
  rationale: z.string(),
  events: z.array(TradeEvent),
});
export type TradeExplanation = z.infer<typeof TradeExplanation>;

/** A rendered section of the daily brief. `body` is already HTML. */
export interface BriefSection {
  title: string;
  body: string;
}

export type NotifyLevel = "info" | "warn" | "critical";
