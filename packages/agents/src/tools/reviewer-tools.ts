import type {
  AnalystPrior,
  EwAnalysis,
  EwCandidate,
  MarketSnapshot,
  RiskLimits,
  TradePlan,
} from "@surf/core";
import { priorFreshness } from "../prompts/analyze.js";

/** Deterministic helpers the reviewer may call. All pure; the caller may substitute its own. */
export interface ReviewerTools {
  getCandidate(id: string): EwCandidate | null;
  checkStopVsInvalidation(plan: TradePlan): StopCheck;
  recomputeRewardRisk(plan: TradePlan): RewardRiskCheck;
  getPriorLevels(): PriorLevels | null;
}

export interface StopCheck {
  ok: boolean;
  detail: string;
  stop: number | null;
  invalidation: number | null;
  bufferPct: number | null;
  stopDistancePct: number | null;
}

export interface RewardRiskCheck {
  rewardRisk: number | null;
  detail: string;
  entryPrice: number | null;
  riskPerUnit: number | null;
  rewardPerUnitAfterCosts: number | null;
  feePerUnit: number | null;
  fundingPerUnit: number | null;
}

export interface PriorLevels {
  videoId: string;
  bias: AnalystPrior["bias"];
  invalidation: number | null;
  targets: number[];
  entryZone: { low: number; high: number } | null;
  keyLevels: number[];
  ageHours: number;
  fresh: boolean;
}

export interface ReviewerToolInputs {
  ew: { h1: EwAnalysis; h4: EwAnalysis };
  prior: AnalystPrior | null;
  market: MarketSnapshot;
  limits: RiskLimits;
  priorMaxAgeHours?: number;
}

export const TAKER_FEE = 0.0005;

/** Worst-case fill inside the zone: far edge from the target. Market entries use the mark. */
export function worstEntryPrice(plan: TradePlan, market: MarketSnapshot): number | null {
  if (!plan.direction || !plan.entry) return null;
  if (plan.entryKind === "market") return market.markPrice;
  return plan.direction === "long" ? plan.entry.high : plan.entry.low;
}

export function findCandidate(ew: ReviewerToolInputs["ew"], id: string): EwCandidate | null {
  return [...ew.h1.candidates, ...ew.h4.candidates].find((c) => c.id === id) ?? null;
}

/** Mirrors the risk engine's geometry rules so the reviewer sees the same verdict code will reach. */
export function createReviewerTools(inputs: ReviewerToolInputs): ReviewerTools {
  const { ew, prior, market, limits } = inputs;
  return {
    getCandidate: (id) => findCandidate(ew, id),

    checkStopVsInvalidation(plan) {
      const empty: StopCheck = {
        ok: false,
        detail: "",
        stop: null,
        invalidation: null,
        bufferPct: null,
        stopDistancePct: null,
      };
      if (plan.action !== "enter")
        return { ...empty, detail: `action=${plan.action}: no entry stop to check` };
      if (!plan.direction || !plan.stopLoss || !plan.candidateId)
        return { ...empty, detail: "plan lacks direction, stop or candidateId" };
      const cand = findCandidate(ew, plan.candidateId);
      if (!cand)
        return { ...empty, stop: plan.stopLoss.price, detail: `candidate ${plan.candidateId} not found` };
      const stop = plan.stopLoss.price;
      const inv = cand.invalidation.price;
      const beyond = plan.direction === "long" ? stop <= inv : stop >= inv;
      const bufferPct = (Math.abs(stop - inv) / inv) * 100;
      const entry = worstEntryPrice(plan, market);
      const stopDistancePct = entry === null ? null : (Math.abs(entry - stop) / entry) * 100;
      const losingSide = entry === null ? false : plan.direction === "long" ? stop < entry : stop > entry;
      const inBand =
        stopDistancePct !== null &&
        stopDistancePct >= limits.minStopDistancePct &&
        stopDistancePct <= limits.maxStopDistancePct;
      const directionOk = cand.direction === plan.direction;
      const ok = beyond && losingSide && inBand && directionOk;
      const detail = [
        `stop ${stop} ${beyond ? "beyond" : "INSIDE"} invalidation ${inv} (buffer ${bufferPct.toFixed(2)}%)`,
        losingSide ? "stop on losing side of entry" : "stop NOT on losing side of entry",
        stopDistancePct === null
          ? "no entry price"
          : `stop distance ${stopDistancePct.toFixed(2)}% (band ${limits.minStopDistancePct}-${limits.maxStopDistancePct}%) ${inBand ? "ok" : "OUT OF BAND"}`,
        directionOk
          ? "candidate direction matches"
          : `candidate direction ${cand.direction} != plan ${plan.direction}`,
      ].join("; ");
      return { ok, detail, stop, invalidation: inv, bufferPct, stopDistancePct };
    },

    recomputeRewardRisk(plan) {
      const empty: RewardRiskCheck = {
        rewardRisk: null,
        detail: "",
        entryPrice: null,
        riskPerUnit: null,
        rewardPerUnitAfterCosts: null,
        feePerUnit: null,
        fundingPerUnit: null,
      };
      if (plan.action !== "enter") return { ...empty, detail: `action=${plan.action}: nothing to recompute` };
      const entry = worstEntryPrice(plan, market);
      if (entry === null || !plan.direction || !plan.stopLoss || !plan.takeProfit)
        return { ...empty, detail: "plan lacks entry, direction, stop or target" };
      const stop = plan.stopLoss.price;
      const target = plan.takeProfit.price;
      const risk = plan.direction === "long" ? entry - stop : stop - entry;
      if (risk <= 0)
        return {
          ...empty,
          entryPrice: entry,
          riskPerUnit: risk,
          detail: "stop is not on the losing side of entry",
        };
      const gross = plan.direction === "long" ? target - entry : entry - target;
      const holdHours = plan.expectedHoldHours ?? 24;
      const feePerUnit = entry * (TAKER_FEE + (plan.entryKind === "market" ? TAKER_FEE : 0));
      const fundingSign = plan.direction === "long" ? 1 : -1;
      const fundingPerUnit = Math.max(0, fundingSign * market.fundingRateHourly * entry * holdHours);
      const reward = gross - feePerUnit - fundingPerUnit;
      const rr = reward / risk;
      return {
        rewardRisk: Number(rr.toFixed(3)),
        detail: `entry ${entry} stop ${stop} target ${target}: risk/unit ${risk.toFixed(1)}, gross ${gross.toFixed(1)}, fees ${feePerUnit.toFixed(1)}, funding(${holdHours}h) ${fundingPerUnit.toFixed(1)} -> R:R ${rr.toFixed(2)} (min ${limits.minRewardRisk})`,
        entryPrice: entry,
        riskPerUnit: risk,
        rewardPerUnitAfterCosts: reward,
        feePerUnit,
        fundingPerUnit,
      };
    },

    getPriorLevels() {
      if (!prior) return null;
      const fresh = priorFreshness(prior, market.asOf, inputs.priorMaxAgeHours ?? 48)!;
      return {
        videoId: prior.videoId,
        bias: prior.bias,
        invalidation: prior.invalidation?.price ?? null,
        targets: prior.targets.map((t) => t.price),
        entryZone: prior.entryZone ? { low: prior.entryZone.low, high: prior.entryZone.high } : null,
        keyLevels: prior.keyLevels.map((l) => l.price),
        ageHours: fresh.ageHours,
        fresh: fresh.fresh,
      };
    },
  };
}
