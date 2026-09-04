import type { Confidence } from "@surf/core";
import type {
  CalibrationSummary as AgentsCalibration,
  JournalEntry,
  OpenPositionContext,
  OutcomeFacts,
} from "@surf/agents";
import type { Db } from "../db/index.js";
import { closedPositions, type PositionRow } from "../db/queries.js";
import { summarizeCalibration, type BucketStats, type ClosedTradeLite } from "./calibration.js";
import { computeOutcome, type OutcomeFacts as CodeOutcome } from "./outcome.js";
import type { Candle } from "@surf/core";

export function journalOf(p: PositionRow): JournalEntry {
  return p.journal as JournalEntry;
}

export function outcomeLabel(realizedR: number): "win" | "loss" | "scratch" {
  return realizedR > 0.1 ? "win" : realizedR < -0.1 ? "loss" : "scratch";
}

export function toClosedTradeLite(p: PositionRow): ClosedTradeLite {
  const j = journalOf(p);
  const r = p.realizedR ?? 0;
  return {
    confidence: (j.reviewerConfidence ?? "medium") as Confidence,
    setup: j.setup ?? null,
    hadPrior: j.priorVideoId !== null && j.priorVideoId !== undefined,
    realizedR: r,
    outcome: outcomeLabel(r),
  };
}

function bucket(s: BucketStats): AgentsCalibration["byConfidence"]["low"] {
  return {
    n: s.n,
    hitRate: s.n > 0 ? s.winRate : null,
    brier: s.brier !== null ? Math.min(1, Math.max(0, s.brier)) : null,
    avgR: s.n > 0 ? s.avgR : null,
  };
}

/** Agents-shaped calibration ledger from the closed `positions` rows. Accuracy buckets are null in v1. */
export function calibrationForAgents(db: Db, now: number): AgentsCalibration {
  const rows = closedPositions(db).filter((p) => p.realizedR !== null);
  const c = summarizeCalibration(rows.map(toClosedTradeLite));
  return {
    asOf: now,
    closedTrades: c.totalTrades,
    byConfidence: {
      low: bucket(c.byConfidence.low),
      medium: bucket(c.byConfidence.medium),
      high: bucket(c.byConfidence.high),
    },
    bySetup: Object.fromEntries(Object.entries(c.bySetup).map(([k, v]) => [k, bucket(v)])),
    priorAccuracy: null,
    ownCountAccuracy: null,
  };
}

export function openPositionContext(p: PositionRow): OpenPositionContext {
  const j = journalOf(p);
  return {
    tradeId: p.id,
    openedAt: p.openedAt ?? p.createdAt,
    direction: p.direction as "long" | "short",
    entryPrice: p.entryPrice ?? p.plannedEntry ?? p.stopLoss,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    candidateId: j.candidateId ?? null,
    priorVideoId: j.priorVideoId ?? null,
    thesis: (j.rationale ?? "").slice(0, 1000),
  };
}

export type AgentsExitReason = OutcomeFacts["exitReason"];

/** Map the daemon's exit reasons onto the agents' enum. */
export function agentsExitReason(p: PositionRow, priceTick: number): AgentsExitReason {
  const r = p.exitReason ?? "manual";
  if (r === "stop") {
    const be = p.entryPrice !== null && Math.abs(p.stopLoss - p.entryPrice) <= 2 * priceTick;
    return be ? "breakeven-stop" : "stop";
  }
  if (r === "take-profit") return "target";
  if (r === "invalidation") return "invalidation-flatten";
  if (r === "expired") return "expired";
  if (r === "halt") return "halt";
  return "manual";
}

/** Code-computed outcome for a closed position, in both the daemon and agents shapes. */
export function outcomeForPosition(
  p: PositionRow,
  candles: Candle[],
  priceTick: number,
): { code: CodeOutcome; facts: OutcomeFacts } {
  const openedAt = p.openedAt ?? p.createdAt;
  const closedAt = p.closedAt ?? openedAt;
  const entry = p.entryPrice ?? p.plannedEntry ?? 0;
  const exit = p.exitPrice ?? entry;
  const code = computeOutcome({
    direction: p.direction as "long" | "short",
    entryPrice: entry,
    exitPrice: exit,
    size: p.size,
    initialStop: p.initialStop,
    fees: p.fees,
    fundingPaid: p.fundingPaid,
    openedAt,
    closedAt,
    candles,
  });
  const exitReason = agentsExitReason(p, priceTick);
  const planned = p.plannedEntry;
  const slippageBps =
    planned !== null && planned > 0 && p.entryPrice !== null
      ? (Math.abs(p.entryPrice - planned) / planned) * 10_000
      : null;
  const facts: OutcomeFacts = {
    tradeId: p.id,
    realizedR: code.realizedR,
    realizedPnlUsd: code.netPnl,
    maeR: Math.abs(code.maeR),
    mfeR: Math.max(0, code.mfeR),
    holdHours: Math.max(0, code.holdHours),
    feesUsd: p.fees,
    fundingUsd: p.fundingPaid,
    slippageBps,
    exitReason,
    hitFirst:
      exitReason === "target"
        ? "target"
        : exitReason === "stop" || exitReason === "invalidation-flatten"
          ? "invalidation"
          : "neither",
    countSurvivedBars: null,
  };
  return { code, facts };
}
