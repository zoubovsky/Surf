import type { Candle, Direction } from "@surf/core";

export interface OutcomeInput {
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  size: number;
  initialStop: number;
  fees: number;
  fundingPaid: number;
  openedAt: number;
  closedAt: number;
  /** Candles spanning the holding period, for MAE/MFE. */
  candles: Candle[];
}

export interface OutcomeFacts {
  grossPnl: number;
  netPnl: number;
  riskUsd: number;
  realizedR: number;
  holdHours: number;
  /** Maximum adverse excursion in R (negative or zero). */
  maeR: number;
  /** Maximum favourable excursion in R (positive or zero). */
  mfeR: number;
  outcome: "win" | "loss" | "scratch";
}

/** Deterministic outcome facts. Never computed by a model. */
export function computeOutcome(i: OutcomeInput): OutcomeFacts {
  const dir = i.direction === "long" ? 1 : -1;
  const grossPnl = dir * (i.exitPrice - i.entryPrice) * i.size;
  const netPnl = grossPnl - i.fees - i.fundingPaid;
  const stopDist = Math.abs(i.entryPrice - i.initialStop);
  const riskUsd = stopDist * i.size;
  const realizedR = riskUsd > 0 ? netPnl / riskUsd : 0;
  let worst = 0;
  let best = 0;
  for (const c of i.candles) {
    if (c.closeTime < i.openedAt || c.openTime > i.closedAt) continue;
    const adverse = dir === 1 ? i.entryPrice - c.low : c.high - i.entryPrice;
    const favourable = dir === 1 ? c.high - i.entryPrice : i.entryPrice - c.low;
    worst = Math.max(worst, adverse);
    best = Math.max(best, favourable);
  }
  const maeR = stopDist > 0 ? -worst / stopDist : 0;
  const mfeR = stopDist > 0 ? best / stopDist : 0;
  const outcome = realizedR > 0.1 ? "win" : realizedR < -0.1 ? "loss" : "scratch";
  return {
    grossPnl,
    netPnl,
    riskUsd,
    realizedR,
    holdHours: (i.closedAt - i.openedAt) / 3_600_000,
    maeR,
    mfeR,
    outcome,
  };
}
