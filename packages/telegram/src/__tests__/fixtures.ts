import type {
  AccountSnapshot,
  AnalystPrior,
  EwAnalysis,
  EwCandidate,
  Logger,
  MarketSnapshot,
  ReviewVerdict,
  RiskDecision,
  RiskLimits,
  SizedOrder,
  TradePlan,
} from "@surf/core";
import { vi } from "vitest";
import type { OpenOrderView, PnlReport, StatusReport, TradeExplanation } from "../types.js";

export const T0 = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04 12:00Z

export function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

export const limits: RiskLimits = {
  riskPerTradePct: 1,
  maxLeverage: 5,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxEntriesPerDay: 4,
  minHoursBetweenEntries: 2,
  maxDepthFraction: 0.1,
  minRewardRisk: 2,
  maxStopDistancePct: 6,
  minStopDistancePct: 0.3,
  maxCandleAgeMs: 7_200_000,
  maxReferenceDeviationPct: 1,
  maxConsecutiveStopOuts: 3,
  haltCooldownHours: 24,
  dailyLlmBudgetUsd: 10,
  minConfidenceToTrade: "high",
  maxAdverseFundingHourly: 0.0005,
  minNotionalUsd: 10,
  sizeStep: 0.00001,
  priceTick: 0.1,
};

export const account: AccountSnapshot = {
  asOf: T0 - 30_000,
  equity: 10_000,
  availableBalance: 9_500,
  openPositions: [
    {
      symbol: "BTC-USD",
      direction: "long",
      size: 0.0123456,
      entryPrice: 111_234.56,
      leverage: 3,
      liquidationPrice: 80_000,
      unrealizedPnl: 45.678,
    },
  ],
  openOrders: 2,
};

export const market: MarketSnapshot = {
  asOf: T0 - 1000,
  symbol: "BTC-USD",
  markPrice: 112_345.678,
  indexPrice: 112_300,
  referencePrice: 112_310,
  bestBid: 112_340,
  bestAsk: 112_350,
  depthNotionalNear: 2_500_000,
  fundingRateHourly: 0.0001,
  nextFundingTime: T0 + 3_600_000,
  lastCandleCloseTime: T0 - 600_000,
};

export const orders: OpenOrderView[] = [
  {
    orderId: "o-stop-1",
    tradeId: "t-001",
    symbol: "BTC-USD",
    role: "stop-loss",
    side: "sell",
    type: "stop",
    price: null,
    triggerPrice: 108_500,
    size: 0.0123456,
    filledSize: 0,
    reduceOnly: true,
    status: "open",
    createdAt: T0 - 3_600_000,
  },
  {
    orderId: "o-tp-1",
    tradeId: "t-001",
    symbol: "BTC-USD",
    role: "take-profit",
    side: "sell",
    type: "take-profit",
    price: null,
    triggerPrice: 118_000,
    size: 0.0123456,
    filledSize: 0,
    reduceOnly: true,
    status: "open",
    createdAt: T0 - 3_600_000,
  },
  {
    orderId: "o-entry-2",
    tradeId: "t-002",
    symbol: "BTC-USD",
    role: "entry",
    side: "buy",
    type: "limit",
    price: 109_900,
    triggerPrice: null,
    size: 0.01,
    filledSize: 0.002,
    reduceOnly: false,
    status: "open",
    createdAt: T0 - 600_000,
  },
];

export const pnl: PnlReport = {
  range: "today",
  asOf: T0,
  from: T0 - 12 * 3_600_000,
  startEquity: 9_800,
  endEquity: 10_045.68,
  realizedUsd: 1234.56,
  unrealizedUsd: 45.678,
  feesUsd: 12.3,
  fundingUsd: -2.5,
  netUsd: 245.68,
  netPct: 2.5069,
  maxDrawdownPct: 1.234,
  trades: 3,
  wins: 2,
  losses: 1,
  avgR: 0.75,
  bestR: 2.1,
  worstR: -1,
  rows: [
    {
      tradeId: "t-000",
      closedAt: T0 - 3_600_000,
      direction: "long",
      setup: "wave-2-end",
      realizedUsd: 210,
      realizedR: 2.1,
    },
    {
      tradeId: "t-minus-1",
      closedAt: T0 - 7_200_000,
      direction: "short",
      setup: null,
      realizedUsd: -100,
      realizedR: -1,
    },
  ],
};

export const status: StatusReport = {
  asOf: T0,
  mode: "live",
  paused: false,
  halted: false,
  haltReason: null,
  haltedAt: null,
  startedAt: T0 - 90_061_000, // 1d 1h
  symbol: "BTC-USD",
  lastCandleCloseTime: T0 - 600_000,
  lastCycleAt: T0 - 120_000,
  lastCycleTerminal: "no-op",
  feeds: [
    { name: "strike-ws", health: "ok", lastEventAt: T0 - 2000, detail: null },
    { name: "youtube", health: "degraded", lastEventAt: T0 - 86_400_000, detail: "quota <low>" },
  ],
  lastError: { at: T0 - 3_600_000, context: "loop-b", message: "Timeout <5s> & retry" },
  llmSpendTodayUsd: 1.2345,
  llmBudgetUsd: 10,
  openPositions: 1,
  openOrders: 3,
  entriesToday: 1,
  consecutiveStopOuts: 0,
  version: "0.1.0",
};

export function candidate(over: Partial<EwCandidate> = {}): EwCandidate {
  return {
    id: "c-1",
    interval: "1h",
    pattern: "impulse",
    direction: "long",
    position: "in-wave-2",
    pivots: [
      { index: 0, time: T0 - 40 * 3_600_000, price: 100_000, kind: "low" },
      { index: 20, time: T0 - 20 * 3_600_000, price: 115_000, kind: "high" },
    ],
    invalidation: { price: 99_999.9, label: "below wave 1 start" },
    targets: [{ low: 118_000, high: 121_000, label: "wave 3 = 1.618 x wave 1" }],
    entryZone: { low: 108_000, high: 110_000, label: "0.5-0.618 retrace" },
    score: 0.82,
    hardRulesPassed: true,
    notes: ["alternation ok"],
    ...over,
  };
}

export const ew: EwAnalysis = {
  symbol: "BTC-USD",
  interval: "1h",
  asOf: T0,
  lastClose: 112_345.6,
  swings: [],
  candidates: [
    candidate({ id: "c-low", score: 0.31, pattern: "zigzag", direction: "short", position: "in-wave-c" }),
    candidate({ id: "c-top", score: 0.91 }),
    candidate({
      id: "c-mid",
      score: 0.55,
      pattern: "flat",
      position: "in-wave-b",
      entryZone: null,
      targets: [],
    }),
    candidate({ id: "c-4th", score: 0.12, pattern: "triangle" }),
  ],
  momentum: { rsi14: 41.2, rsiDivergence: "bullish", atr14: 850.5 },
};

export const plan: TradePlan = {
  action: "enter",
  direction: "long",
  candidateId: "c-top",
  priorVideoId: "vid-1",
  setup: "wave-2-end",
  entry: { low: 108_000, high: 110_000, label: "0.5-0.618 retrace" },
  entryKind: "limit",
  stopLoss: { price: 107_000, label: "below invalidation" },
  takeProfit: { price: 118_000, label: "wave 3 target" },
  newStop: null,
  expectedHoldHours: 36,
  confidence: "high",
  evidence: ["c-top", "vid-1", "rsi14"],
  priorDisagrees: false,
  rationale: "Wave 2 retrace into 0.618 with bullish RSI divergence & prior agrees <mco>.",
};

export const review: ReviewVerdict = {
  verdict: "approve",
  adjustedConfidence: "high",
  reasons: ["stop beyond invalidation", "R:R 2.7 recomputed"],
  checks: {
    dataFresh: true,
    evidenceTraceable: true,
    stopBeyondInvalidation: true,
    rewardRiskRecomputed: 2.7,
    priorConsistent: true,
    stateConsistent: true,
  },
  severity: "none",
};

export const order: SizedOrder = {
  symbol: "BTC-USD",
  direction: "long",
  entryKind: "limit",
  entryPrice: 109_000,
  size: 0.045,
  notionalUsd: 4905,
  leverage: 3,
  marginUsd: 1635,
  stopLoss: 107_000,
  takeProfit: 118_000,
  riskUsd: 90,
  rewardRisk: 4.5,
  expectedFundingUsd: -1.2,
};

export const riskAllow: RiskDecision = {
  verdict: "allow",
  planHash: "abc",
  checks: [
    { rule: "not-paused", passed: true, detail: "ok" },
    { rule: "reviewer-approved", passed: true, detail: "ok" },
  ],
  order,
  terminal: "traded",
  summary: "all checks passed",
};

export const riskDeny: RiskDecision = {
  verdict: "deny",
  planHash: "abc",
  checks: [
    { rule: "not-paused", passed: true, detail: "ok" },
    { rule: "confidence", passed: false, detail: "reviewer confidence=medium, required>=high" },
  ],
  order: null,
  terminal: "blocked",
  summary: "confidence below threshold",
};

export const prior: AnalystPrior = {
  videoId: "vid-1",
  publishedAt: T0 - 5 * 3_600_000,
  title: "BTC Update: Wave 2 & Wave 3 <live>",
  asset: "BTC",
  bias: "long",
  timeframe: "1h/4h",
  primaryCount: "Wave 2 of (3) completing near 108k",
  alternateCount: "Deeper B wave to 104k",
  keyLevels: [{ price: 108_000, label: "0.618" }],
  invalidation: { price: 100_000, label: "wave 1 low" },
  targets: [{ price: 118_000, label: "wave 3" }],
  entryZone: { low: 107_500, high: 109_500, label: "buy zone" },
  confidence: "medium",
  evidence: ["I'd look for support around 108k"],
  summary: "Bullish as long as 100k holds.",
};

export const why: TradeExplanation = {
  tradeId: "t-001",
  symbol: "BTC-USD",
  direction: "long",
  setup: "wave-2-end",
  candidateId: "c-top",
  priorVideoId: "vid-1",
  openedAt: T0 - 5 * 3_600_000,
  closedAt: null,
  entryPrice: 111_234.56,
  size: 0.0123456,
  leverage: 3,
  stopLoss: 108_500,
  takeProfit: 118_000,
  exitPrice: null,
  realizedUsd: null,
  realizedR: null,
  confidence: "high",
  reviewVerdict: "approve",
  reviewReasons: ["stop beyond invalidation"],
  riskSummary: "all checks passed",
  evidence: ["c-top", "vid-1"],
  rationale: "Because <wave 2> ended & RSI diverged.",
  events: [{ at: T0 - 5 * 3_600_000, kind: "placed", detail: "limit @ 111,200" }],
};
