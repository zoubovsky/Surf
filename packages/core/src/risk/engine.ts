import { createHash } from "node:crypto";
import { CONFIDENCE_RANK } from "../schemas/common.js";
import type {
  AccountSnapshot,
  MarketSnapshot,
  ReviewVerdict,
  RiskCheck,
  RiskDecision,
  RiskLimits,
  SizedOrder,
  TradePlan,
  TradingState,
} from "../schemas/trading.js";
import type { EwCandidate } from "../schemas/elliott.js";
import { expectedFundingUsd, roundToTick, sizePosition } from "./sizing.js";

export interface RiskInput {
  plan: TradePlan;
  review: ReviewVerdict;
  candidate: EwCandidate | null;
  account: AccountSnapshot;
  market: MarketSnapshot;
  state: TradingState;
  limits: RiskLimits;
  now: number;
}

export function hashPlan(plan: TradePlan, review: ReviewVerdict): string {
  return createHash("sha256").update(JSON.stringify({ plan, review })).digest("hex").slice(0, 32);
}

function check(rule: string, passed: boolean, detail: string): RiskCheck {
  return { rule, passed, detail };
}

/**
 * Deterministic pre-trade gate. Every rule is evaluated and recorded even after a failure,
 * so the journal shows the full picture. Returns a SizedOrder only when every rule passes.
 */
export function evaluateRisk(input: RiskInput): RiskDecision {
  const { plan, review, candidate, account, market, state, limits, now } = input;
  const checks: RiskCheck[] = [];
  const planHash = hashPlan(plan, review);
  const deny = (summary: string): RiskDecision => ({
    verdict: "deny",
    planHash,
    checks,
    order: null,
    terminal: "blocked",
    summary,
  });

  if (plan.action !== "enter") {
    checks.push(check("action", true, `action=${plan.action}; risk engine only sizes entries`));
    return { verdict: "deny", planHash, checks, order: null, terminal: plan.action === "hold" ? "hold" : "no-op", summary: "not an entry" };
  }

  // 1. Operator and system state
  checks.push(check("not-paused", !state.paused, state.paused ? "operator paused new entries" : "ok"));
  checks.push(check("not-halted", !state.halted, state.halted ? `halted: ${state.haltReason ?? "unknown"}` : "ok"));
  checks.push(check("llm-budget", state.llmSpendTodayUsd <= limits.dailyLlmBudgetUsd, `spend ${state.llmSpendTodayUsd.toFixed(2)} / ${limits.dailyLlmBudgetUsd}`));

  // 2. Reviewer gate
  checks.push(check("reviewer-approved", review.verdict === "approve", `reviewer verdict=${review.verdict}`));
  const conf = review.adjustedConfidence;
  checks.push(
    check(
      "confidence",
      CONFIDENCE_RANK[conf] >= CONFIDENCE_RANK[limits.minConfidenceToTrade],
      `reviewer confidence=${conf}, required>=${limits.minConfidenceToTrade}`,
    ),
  );
  checks.push(check("prior-agrees", !plan.priorDisagrees, plan.priorDisagrees ? "analyst prior disagrees with count" : "ok"));

  // 3. Plan completeness
  const complete = !!(plan.direction && plan.entry && plan.entryKind && plan.stopLoss && plan.takeProfit && plan.candidateId);
  checks.push(check("plan-complete", complete, complete ? "ok" : "missing direction/entry/stop/target/candidate"));
  if (!complete) return deny("incomplete plan");
  const direction = plan.direction!;
  const entryZone = plan.entry!;
  const stop = plan.stopLoss!.price;
  const target = plan.takeProfit!.price;

  // 4. Candidate linkage and structural invalidation
  checks.push(check("candidate-known", candidate !== null && candidate.id === plan.candidateId, candidate ? "ok" : "candidate not found"));
  if (candidate) {
    checks.push(check("candidate-direction", candidate.direction === direction, `candidate=${candidate.direction} plan=${direction}`));
    const beyond = direction === "long" ? stop <= candidate.invalidation.price : stop >= candidate.invalidation.price;
    checks.push(check("stop-beyond-invalidation", beyond, `stop ${stop} vs invalidation ${candidate.invalidation.price}`));
  }

  // 5. Data freshness and integrity
  const marketAge = now - market.asOf;
  checks.push(check("market-fresh", marketAge >= 0 && marketAge < 120_000, `market snapshot age ${Math.round(marketAge / 1000)}s`));
  const candleAge = market.lastCandleCloseTime === null ? Infinity : now - market.lastCandleCloseTime;
  checks.push(check("candle-fresh", candleAge <= limits.maxCandleAgeMs, `last candle age ${Math.round(candleAge / 60000)}m`));
  if (market.referencePrice !== null) {
    const dev = (Math.abs(market.markPrice - market.referencePrice) / market.referencePrice) * 100;
    checks.push(check("reference-deviation", dev <= limits.maxReferenceDeviationPct, `mark vs reference ${dev.toFixed(2)}%`));
  } else {
    checks.push(check("reference-deviation", false, "no reference price available"));
  }
  const accountAge = now - account.asOf;
  checks.push(check("account-fresh", accountAge >= 0 && accountAge < 120_000, `account snapshot age ${Math.round(accountAge / 1000)}s`));

  // 6. Portfolio limits
  checks.push(
    check("max-positions", account.openPositions.length < limits.maxConcurrentPositions, `open=${account.openPositions.length} max=${limits.maxConcurrentPositions}`),
  );
  const dailyLossPct = state.dayStartEquity > 0 ? ((state.dayStartEquity - account.equity) / state.dayStartEquity) * 100 : 0;
  checks.push(check("daily-loss", dailyLossPct < limits.maxDailyLossPct, `daily loss ${dailyLossPct.toFixed(2)}% max ${limits.maxDailyLossPct}%`));
  const ddPct = state.highWaterEquity > 0 ? ((state.highWaterEquity - account.equity) / state.highWaterEquity) * 100 : 0;
  checks.push(check("drawdown", ddPct < limits.maxDrawdownPct, `drawdown ${ddPct.toFixed(2)}% max ${limits.maxDrawdownPct}%`));
  checks.push(check("entries-today", state.entriesToday < limits.maxEntriesPerDay, `entries today ${state.entriesToday} max ${limits.maxEntriesPerDay}`));
  const sinceLast = state.lastEntryAt === null ? Infinity : (now - state.lastEntryAt) / 3_600_000;
  checks.push(check("entry-spacing", sinceLast >= limits.minHoursBetweenEntries, `hours since last entry ${Number.isFinite(sinceLast) ? sinceLast.toFixed(1) : "n/a"}`));
  checks.push(
    check("consecutive-stop-outs", state.consecutiveStopOuts < limits.maxConsecutiveStopOuts, `consecutive stop-outs ${state.consecutiveStopOuts}`),
  );

  // 7. Geometry: entry, stop, target
  const entryPrice = roundToTick(
    plan.entryKind === "market" ? market.markPrice : direction === "long" ? entryZone.high : entryZone.low,
    limits.priceTick,
  );
  const stopOk = direction === "long" ? stop < entryPrice : stop > entryPrice;
  const targetOk = direction === "long" ? target > entryPrice : target < entryPrice;
  checks.push(check("stop-side", stopOk, `entry ${entryPrice} stop ${stop}`));
  checks.push(check("target-side", targetOk, `entry ${entryPrice} target ${target}`));
  const stopDistPct = (Math.abs(entryPrice - stop) / entryPrice) * 100;
  checks.push(
    check(
      "stop-distance",
      stopDistPct >= limits.minStopDistancePct && stopDistPct <= limits.maxStopDistancePct,
      `stop distance ${stopDistPct.toFixed(2)}% (min ${limits.minStopDistancePct}, max ${limits.maxStopDistancePct})`,
    ),
  );
  if (plan.entryKind === "limit") {
    const restingOk = direction === "long" ? entryPrice < market.markPrice : entryPrice > market.markPrice;
    checks.push(check("resting-entry-side", restingOk, `limit ${entryPrice} vs mark ${market.markPrice}`));
    const distPct = (Math.abs(market.markPrice - entryPrice) / market.markPrice) * 100;
    checks.push(check("resting-entry-distance", distPct <= 4.5, `resting entry ${distPct.toFixed(2)}% from mark (venue bound 5%)`));
  }

  // 8. Funding
  const adverse = direction === "long" ? market.fundingRateHourly : -market.fundingRateHourly;
  checks.push(check("funding-not-extreme", adverse <= limits.maxAdverseFundingHourly, `adverse funding ${(adverse * 100).toFixed(4)}%/h`));

  // 9. Sizing
  const sized = sizePosition({
    equity: account.equity,
    riskPct: limits.riskPerTradePct * (conf === "high" ? 1 : 0.5),
    entryPrice,
    stopLoss: stop,
    direction,
    maxLeverage: limits.maxLeverage,
    sizeStep: limits.sizeStep,
    minNotionalUsd: limits.minNotionalUsd,
  });
  if ("error" in sized) {
    checks.push(check("sizing", false, sized.error));
    return deny("sizing failed: " + sized.error);
  }
  checks.push(check("sizing", true, `size ${sized.size} notional ${sized.notionalUsd.toFixed(2)} lev ${sized.leverage}`));
  checks.push(check("leverage-cap", sized.leverage <= limits.maxLeverage, `leverage ${sized.leverage} max ${limits.maxLeverage}`));
  if (market.depthNotionalNear !== null) {
    checks.push(
      check("depth", sized.notionalUsd <= market.depthNotionalNear * limits.maxDepthFraction, `notional ${sized.notionalUsd.toFixed(0)} vs depth ${market.depthNotionalNear.toFixed(0)}`),
    );
  } else {
    checks.push(check("depth", false, "no depth data"));
  }

  // 10. Reward:risk after fees and funding
  const holdHours = plan.expectedHoldHours ?? 24;
  const funding = expectedFundingUsd(sized.notionalUsd, market.fundingRateHourly, holdHours, direction);
  const feeUsd = sized.notionalUsd * (plan.entryKind === "limit" ? 0 : 0.0005) + sized.notionalUsd * 0.0005; // exit assumed taker
  const rewardUsd = Math.abs(target - entryPrice) * sized.size - feeUsd - Math.max(0, funding);
  const rr = rewardUsd / sized.riskUsd;
  checks.push(check("reward-risk", rr >= limits.minRewardRisk, `R:R after costs ${rr.toFixed(2)} min ${limits.minRewardRisk}`));

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) return deny(`denied: ${failed.map((c) => c.rule).join(", ")}`);

  const order: SizedOrder = {
    symbol: market.symbol,
    direction,
    entryKind: plan.entryKind!,
    entryPrice,
    size: sized.size,
    notionalUsd: sized.notionalUsd,
    leverage: sized.leverage,
    marginUsd: sized.marginUsd,
    stopLoss: roundToTick(stop, limits.priceTick),
    takeProfit: roundToTick(target, limits.priceTick),
    riskUsd: sized.riskUsd,
    rewardRisk: rr,
    expectedFundingUsd: funding,
  };
  return {
    verdict: "allow",
    planHash,
    checks,
    order,
    terminal: plan.entryKind === "limit" ? "resting-placed" : "traded",
    summary: `allow ${direction} ${sized.size} @ ${entryPrice} sl ${order.stopLoss} tp ${order.takeProfit} rr ${rr.toFixed(2)}`,
  };
}
