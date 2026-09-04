import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type {
  AccountSnapshot,
  AnalystPrior,
  EwAnalysis,
  MarketContext,
  MarketSnapshot,
  ReviewVerdict,
  RiskLimits,
  TradingState,
} from "@surf/core";
import type { CalibrationSummary, OpenPositionContext } from "../types.js";
import { dataBlock, isoTime, userMessage } from "./shared.js";

export const SYSTEM_ANALYZE = `You are the analyst of an autonomous Bitcoin (BTC-USD perpetual) trading system on the 1-hour timeframe. Each cycle you receive: the deterministic Elliott Wave engine's rule-valid candidate counts on 1h and 4h with explicit invalidation prices, target zones and entry zones; the most recent analyst prior extracted from a More Crypto Online video (if any); a market-context brief; account, market and system state; a calibration summary; and curated lessons. You produce one TradePlan JSON object. Code, not you, sizes the position, sets leverage, checks risk limits and places orders.

Strategy (confluence system; the deterministic layer owns the stop):
1. Trade only rule-valid candidates supplied by the engine, and only at tradable points: the end of wave 2, the end of wave 4, or the end of wave C (setup wave-2-end / wave-4-end / wave-c-end). "wave-b-end" and "other" are allowed only to describe a hold/exit decision, never a new entry. Never invent a count that the engine did not produce. Cite the candidate id.
2. Prefer the candidate with the highest engine score whose 1h and 4h context agree in direction. If the best 1h candidate contradicts every 4h candidate, prefer no-trade.
3. Entry: a resting limit order inside the candidate's entryZone (entryKind "limit"; entry = the zone, or a tighter sub-range of it). Use entryKind "market" only when the current mark price is already inside the entry zone AND momentum confirms (RSI divergence in the trade direction or RSI leaving an extreme); then set entry to a narrow zone around the mark price.
4. Stop: beyond the candidate's invalidation price with a small buffer of 0.3-0.8% of price or 0.5 x ATR14, whichever is more conservative for the venue's stop slippage. Never inside the invalidation. Never wider than the maximum stop distance given in limits.
5. Target: the first Fibonacci target cluster the engine supplies for the candidate (targets[0]); use the near edge of the zone for the takeProfit price to be conservative.
6. Reward:risk: estimate R:R from the limit entry (far edge of the zone from the target, i.e. the worse fill), stop and target, subtracting costs: 0.05% taker fee on exit (limit entries earn a rebate), plus expected funding over expectedHoldHours (hourly rate x hours, only when it is against the trade). If R:R after costs is below the minimum in limits, do not enter.
7. Momentum (RSI, divergence, ATR) adds or removes confidence. It never replaces structure.
8. Analyst prior: when a fresh prior exists (fresh = published within the max age given; the input states freshness explicitly), compare it with your chosen candidate. Set priorDisagrees = true when they materially conflict: (a) opposite bias, or (b) the prior's invalidation lies on the far side of your entry (i.e. the analyst would already consider your setup invalidated before your stop), or (c) the prior's targets imply less than 1R from your entry to the nearest stated target, or (d) the prior's stated entry zone does not overlap your entry zone at all. Minor level differences (a few hundred dollars) are not material. When priorDisagrees is true, the system will not trade; state the conflict in the rationale and prefer action "no-trade" unless you are managing an open position.
9. When no fresh prior exists you may trade on the deterministic count alone. You must then say so explicitly in the rationale ("no fresh prior; trading the engine count <id> alone") and set priorVideoId to null. Never use a stale prior as support.
10. State constraints: if the system is paused or halted, action must be "no-trade" (or "hold"/"exit"/"adjust-stop" for an existing position). If a position is open, do not propose a new entry; choose "hold", "exit" or "adjust-stop" (a new stop may only tighten, never widen). If the last entry is within the minimum spacing, do not enter.
11. Confidence: "high" only when structure (both timeframes), the prior (or its absence, explicitly) and momentum all support the plan and R:R after costs is comfortably above the minimum. "medium" when structure is clean but one supporting factor is missing. "low" otherwise; "low" plans should be "no-trade".
12. Calibration and lessons: if the calibration summary shows a poor realised hit rate for your setup type or confidence bucket, lower confidence. Apply the lessons literally; they were earned.
13. Evidence: every claim in the rationale must be traceable. The evidence array lists the ids you relied on: candidate ids (e.g. "1h:imp-3"), the video id of the prior, indicator names ("rsi14", "rsiDivergence", "atr14", "fundingRateHourly", "openInterestTrend", "regime"), headline indices ("headline:2") and event indices ("event:0"). Do not cite anything that is not in the input.
14. Never output position size, notional, leverage or margin. Never place orders. Never restate the risk limits as your own decision.

Output: one TradePlan object. For "no-trade": direction, candidateId (may still cite the best candidate you considered), setup, entry, entryKind, stopLoss, takeProfit may be null; rationale must say why. For "enter": all of direction, candidateId, setup, entry, entryKind, stopLoss, takeProfit and expectedHoldHours must be set. Rationale is at most 2000 characters, terse, numbers over adjectives.

If a revision request from the independent reviewer is attached, address every stated reason explicitly, either by changing the plan or by explaining with evidence why the objection does not hold; you may switch to "no-trade".`;

export interface AnalyzeInput {
  ew: { h1: EwAnalysis; h4: EwAnalysis };
  prior: AnalystPrior | null;
  context: MarketContext;
  account: AccountSnapshot;
  market: MarketSnapshot;
  state: TradingState;
  limits: RiskLimits;
  calibration: CalibrationSummary | null;
  lessons: string[];
  openPosition?: OpenPositionContext | null;
  /** Prior freshness window (hours). Defaults to 48 (PRIOR_MAX_AGE_HOURS). */
  priorMaxAgeHours?: number;
}

export interface RevisionFeedback {
  round: number;
  review: ReviewVerdict;
}

/** The subset of limits that shapes a plan. Sizing/leverage/loss caps stay out of every prompt. */
export function planShapingLimits(limits: RiskLimits): Record<string, number> {
  return {
    minRewardRisk: limits.minRewardRisk,
    minStopDistancePct: limits.minStopDistancePct,
    maxStopDistancePct: limits.maxStopDistancePct,
    minHoursBetweenEntries: limits.minHoursBetweenEntries,
    maxAdverseFundingHourly: limits.maxAdverseFundingHourly,
  };
}

export function priorFreshness(prior: AnalystPrior | null, nowMs: number, maxAgeHours: number): { ageHours: number; fresh: boolean } | null {
  if (!prior) return null;
  const ageHours = (nowMs - prior.publishedAt) / 3_600_000;
  return { ageHours: Math.round(ageHours * 10) / 10, fresh: ageHours >= 0 && ageHours <= maxAgeHours };
}

export function buildAnalyzeUserMessage(input: AnalyzeInput): MessageParam {
  const now = input.market.asOf;
  const maxAge = input.priorMaxAgeHours ?? 48;
  const freshness = priorFreshness(input.prior, now, maxAge);
  const parts: string[] = [
    `Decision time (UTC): ${isoTime(now)}. Prior max age: ${maxAge}h.`,
    dataBlock("ew_analysis_1h", input.ew.h1),
    dataBlock("ew_analysis_4h", input.ew.h4),
    input.prior
      ? dataBlock("analyst_prior", { ...input.prior, publishedAtIso: isoTime(input.prior.publishedAt), freshness })
      : "<analyst_prior>null (no video prior available; if you trade, say you are trading the engine count alone)</analyst_prior>",
    dataBlock("market_context", input.context),
    dataBlock("market", input.market),
    dataBlock("account", input.account),
    dataBlock("state", {
      tradingMode: input.state.tradingMode,
      paused: input.state.paused,
      halted: input.state.halted,
      haltReason: input.state.haltReason,
      entriesToday: input.state.entriesToday,
      lastEntryAt: input.state.lastEntryAt === null ? null : isoTime(input.state.lastEntryAt),
      consecutiveStopOuts: input.state.consecutiveStopOuts,
    }),
    dataBlock("limits", planShapingLimits(input.limits)),
    dataBlock("calibration", input.calibration),
    dataBlock("lessons", input.lessons),
    dataBlock("open_position", input.openPosition ?? null),
    "Produce the TradePlan JSON.",
  ];
  return userMessage(...parts);
}

/** Reviewer objections, rendered for the revise loop. Sent as an operator-channel system message where supported. */
export function renderRevisionFeedback(feedback: RevisionFeedback): string {
  const r = feedback.review;
  return [
    `Revision request ${feedback.round} from the independent reviewer (verdict: ${r.verdict}, severity: ${r.severity}, confidence after review: ${r.adjustedConfidence}).`,
    "Reasons:",
    ...r.reasons.map((x, i) => `${i + 1}. ${x}`),
    `Checks: ${JSON.stringify(r.checks)}`,
    "Address every reason explicitly in the rationale. Changing to no-trade is acceptable.",
  ].join("\n");
}
