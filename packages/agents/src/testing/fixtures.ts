import type {
  AccountSnapshot,
  AnalystPrior,
  EwAnalysis,
  EwCandidate,
  MarketContext,
  MarketSnapshot,
  ReviewVerdict,
  RiskLimits,
  TradePlan,
  TradingState,
} from "@surf/core";
import { RiskLimits as RiskLimitsSchema } from "@surf/core";

export const NOW = 1_788_540_000_000;
export const H = 3_600_000;

export function candidate(over: Partial<EwCandidate> = {}): EwCandidate {
  return {
    id: "1h:imp-3",
    interval: "1h",
    pattern: "impulse",
    direction: "long",
    position: "in-wave-2",
    pivots: [
      { index: 0, time: NOW - 40 * H, price: 76_000, kind: "low" },
      { index: 20, time: NOW - 20 * H, price: 80_000, kind: "high" },
    ],
    invalidation: { price: 76_000, label: "wave 1 origin" },
    targets: [{ low: 82_400, high: 83_000, label: "1.618 x W1" }],
    entryZone: { low: 77_500, high: 78_100, label: "50-61.8% of W1" },
    score: 0.8,
    hardRulesPassed: true,
    notes: [],
    ...over,
  };
}

export function ewAnalysis(over: Partial<EwAnalysis> = {}): EwAnalysis {
  return {
    symbol: "BTC-USD",
    interval: "1h",
    asOf: NOW,
    lastClose: 78_400,
    swings: [],
    candidates: [candidate()],
    momentum: { rsi14: 42, rsiDivergence: "bullish", atr14: 450 },
    ...over,
  };
}

export function ew4h(): EwAnalysis {
  return ewAnalysis({ interval: "4h", candidates: [candidate({ id: "4h:imp-1", interval: "4h", position: "in-wave-3" })] });
}

export function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    asOf: NOW,
    symbol: "BTC-USD",
    markPrice: 78_400,
    indexPrice: 78_390,
    referencePrice: 78_410,
    bestBid: 78_399,
    bestAsk: 78_401,
    depthNotionalNear: 400_000,
    fundingRateHourly: 0.00001,
    nextFundingTime: NOW + H,
    lastCandleCloseTime: NOW - 60_000,
    ...over,
  };
}

export function account(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { asOf: NOW, equity: 10_000, availableBalance: 10_000, openPositions: [], openOrders: 0, ...over };
}

export function state(over: Partial<TradingState> = {}): TradingState {
  return {
    tradingMode: "shadow",
    paused: false,
    halted: false,
    haltReason: null,
    haltedAt: null,
    dayStartEquity: 10_000,
    highWaterEquity: 10_000,
    entriesToday: 0,
    lastEntryAt: null,
    consecutiveStopOuts: 0,
    llmSpendTodayUsd: 0,
    ...over,
  };
}

export function limits(over: Partial<RiskLimits> = {}): RiskLimits {
  return RiskLimitsSchema.parse(over);
}

export const TRANSCRIPT =
  "okay so looking at bitcoin on the one hour chart we have this impulse from the 76k low and what I think is a wave two " +
  "pullback into the 77,500 to 78,100 area. as long as we hold above 76,000 the count is valid and the invalidation is " +
  "obviously at 76k. the first target for wave three sits around 82,400 and then 83k above that. if we lose 76,000 then " +
  "we are probably in a bigger correction and I would look at 72k as the next support.";

export function prior(over: Partial<AnalystPrior> = {}): AnalystPrior {
  return {
    videoId: "vid1",
    publishedAt: NOW - 6 * H,
    title: "Bitcoin wave 2 pullback",
    asset: "BTC",
    bias: "long",
    timeframe: "1h, next few days",
    primaryCount: "wave 2 pullback of the impulse from 76k; wave 3 targets 82.4-83k",
    alternateCount: "loss of 76k opens a larger correction toward 72k",
    keyLevels: [{ price: 76_000, label: "wave 1 origin" }],
    invalidation: { price: 76_000, label: "below 76k" },
    targets: [{ price: 82_400, label: "wave 3 first target" }],
    entryZone: { low: 77_500, high: 78_100, label: "wave 2 zone" },
    confidence: "high",
    evidence: [
      "as long as we hold above 76,000 the count is valid and the invalidation is obviously at 76k",
      "the first target for wave three sits around 82,400 and then 83k above that",
      "pullback into the 77,500 to 78,100 area",
    ],
    summary: "Analyst sees a wave 2 pullback into 77.5-78.1k with invalidation at 76k and a first target at 82.4k.",
    ...over,
  };
}

export function context(over: Partial<MarketContext> = {}): MarketContext {
  return {
    asOf: NOW,
    regime: "trending-up",
    fundingRateHourly: 0.00001,
    fundingAssessment: "neutral",
    openInterestTrend: "rising",
    eventRisk: [{ when: NOW + 20 * H, description: "US CPI release", severity: "high" }],
    headlines: ["coindesk.com: spot ETF inflows continue"],
    brief: "BTC trending up on rising OI with neutral funding; CPI in 20h is the main event risk.",
    ...over,
  };
}

export function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    action: "enter",
    direction: "long",
    candidateId: "1h:imp-3",
    priorVideoId: "vid1",
    setup: "wave-2-end",
    entry: { low: 77_500, high: 78_100, label: "fib zone" },
    entryKind: "limit",
    stopLoss: { price: 75_600, label: "below W1 origin with 0.5% buffer" },
    takeProfit: { price: 82_400, label: "near edge of first target" },
    newStop: null,
    expectedHoldHours: 24,
    confidence: "high",
    evidence: ["1h:imp-3", "4h:imp-1", "vid1", "rsiDivergence bullish", "headline:0"],
    priorDisagrees: false,
    rationale: "Wave-2-end long on 1h:imp-3 confirmed by 4h:imp-1; prior vid1 agrees; R:R ~1.7 after costs.",
    ...over,
  };
}

export function verdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    verdict: "approve",
    adjustedConfidence: "high",
    reasons: ["all checks pass"],
    checks: {
      dataFresh: true,
      evidenceTraceable: true,
      stopBeyondInvalidation: true,
      rewardRiskRecomputed: 2.4,
      priorConsistent: true,
      stateConsistent: true,
    },
    severity: "none",
    ...over,
  };
}
