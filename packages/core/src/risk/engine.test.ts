import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskInput } from "./engine.js";
import { RiskLimits } from "../schemas/trading.js";
import type { AccountSnapshot, MarketSnapshot, ReviewVerdict, TradePlan, TradingState } from "../schemas/trading.js";
import type { EwCandidate } from "../schemas/elliott.js";

const NOW = 1_788_540_000_000;

function candidate(over: Partial<EwCandidate> = {}): EwCandidate {
  return {
    id: "cand-1",
    interval: "1h",
    pattern: "impulse",
    direction: "long",
    position: "in-wave-2",
    pivots: [
      { index: 0, time: NOW - 40 * 3_600_000, price: 76_000, kind: "low" },
      { index: 20, time: NOW - 20 * 3_600_000, price: 80_000, kind: "high" },
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

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    action: "enter",
    direction: "long",
    candidateId: "cand-1",
    priorVideoId: "vid1",
    setup: "wave-2-end",
    entry: { low: 77_500, high: 78_100, label: "fib zone" },
    entryKind: "limit",
    stopLoss: { price: 75_800, label: "below W1 origin" },
    takeProfit: { price: 83_000, label: "W3 target" },
    newStop: null,
    expectedHoldHours: 24,
    confidence: "high",
    evidence: ["cand-1", "vid1"],
    priorDisagrees: false,
    rationale: "test",
    ...over,
  };
}

function review(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    verdict: "approve",
    adjustedConfidence: "high",
    reasons: ["ok"],
    checks: {
      dataFresh: true,
      evidenceTraceable: true,
      stopBeyondInvalidation: true,
      rewardRiskRecomputed: 2.5,
      priorConsistent: true,
      stateConsistent: true,
    },
    severity: "none",
    ...over,
  };
}

function account(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { asOf: NOW - 5_000, equity: 10_000, availableBalance: 10_000, openPositions: [], openOrders: 0, ...over };
}

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    asOf: NOW - 3_000,
    symbol: "BTC-USD",
    markPrice: 79_500,
    indexPrice: 79_500,
    referencePrice: 79_520,
    bestBid: 79_499,
    bestAsk: 79_501,
    depthNotionalNear: 500_000,
    fundingRateHourly: 0.00001,
    nextFundingTime: NOW + 600_000,
    lastCandleCloseTime: NOW - 10 * 60_000,
    ...over,
  };
}

function state(over: Partial<TradingState> = {}): TradingState {
  return {
    tradingMode: "live",
    paused: false,
    halted: false,
    haltReason: null,
    haltedAt: null,
    dayStartEquity: 10_000,
    highWaterEquity: 10_000,
    entriesToday: 0,
    lastEntryAt: null,
    consecutiveStopOuts: 0,
    llmSpendTodayUsd: 1,
    ...over,
  };
}

function input(over: Partial<RiskInput> = {}): RiskInput {
  return {
    plan: plan(),
    review: review(),
    candidate: candidate(),
    account: account(),
    market: market(),
    state: state(),
    limits: RiskLimits.parse({}),
    now: NOW,
    ...over,
  };
}

const failedRules = (d: ReturnType<typeof evaluateRisk>) => d.checks.filter((c) => !c.passed).map((c) => c.rule);

describe("evaluateRisk", () => {
  it("allows a clean long resting entry and sizes it to 1% risk", () => {
    const d = evaluateRisk(input());
    expect(failedRules(d)).toEqual([]);
    expect(d.verdict).toBe("allow");
    expect(d.terminal).toBe("resting-placed");
    const o = d.order!;
    expect(o.entryPrice).toBe(78_100);
    expect(o.stopLoss).toBe(75_800);
    // risk 1% of 10k = 100 USD over a 2300 USD stop distance
    expect(o.riskUsd).toBeCloseTo(100, 0);
    expect(o.size).toBeCloseTo(0.04347, 4);
    expect(o.leverage).toBeLessThanOrEqual(5);
    expect(o.rewardRisk).toBeGreaterThan(1.5);
  });

  it("denies when the reviewer did not approve", () => {
    const d = evaluateRisk(input({ review: review({ verdict: "revise" }) }));
    expect(d.verdict).toBe("deny");
    expect(failedRules(d)).toContain("reviewer-approved");
  });

  it("denies when reviewer confidence is below the threshold", () => {
    const d = evaluateRisk(input({ review: review({ adjustedConfidence: "medium" }) }));
    expect(failedRules(d)).toContain("confidence");
  });

  it("denies when the analyst prior disagrees with the count", () => {
    const d = evaluateRisk(input({ plan: plan({ priorDisagrees: true }) }));
    expect(failedRules(d)).toContain("prior-agrees");
  });

  it("denies when the stop is inside the structural invalidation", () => {
    const d = evaluateRisk(input({ plan: plan({ stopLoss: { price: 76_500, label: "too tight" } }) }));
    expect(failedRules(d)).toContain("stop-beyond-invalidation");
  });

  it("denies when paused, halted, or over LLM budget", () => {
    expect(failedRules(evaluateRisk(input({ state: state({ paused: true }) })))).toContain("not-paused");
    expect(failedRules(evaluateRisk(input({ state: state({ halted: true, haltReason: "dd" }) })))).toContain("not-halted");
    expect(failedRules(evaluateRisk(input({ state: state({ llmSpendTodayUsd: 50 }) })))).toContain("llm-budget");
  });

  it("denies on stale market data, stale candle, or reference deviation", () => {
    expect(failedRules(evaluateRisk(input({ market: market({ asOf: NOW - 300_000 }) })))).toContain("market-fresh");
    expect(failedRules(evaluateRisk(input({ market: market({ lastCandleCloseTime: NOW - 3 * 3_600_000 }) })))).toContain(
      "candle-fresh",
    );
    expect(failedRules(evaluateRisk(input({ market: market({ referencePrice: 81_000 }) })))).toContain("reference-deviation");
    expect(failedRules(evaluateRisk(input({ market: market({ referencePrice: null }) })))).toContain("reference-deviation");
  });

  it("denies when a position is already open or entries are too frequent", () => {
    const pos = {
      symbol: "BTC-USD",
      direction: "long" as const,
      size: 0.01,
      entryPrice: 79_000,
      leverage: 2,
      liquidationPrice: 60_000,
      unrealizedPnl: 0,
    };
    expect(failedRules(evaluateRisk(input({ account: account({ openPositions: [pos] }) })))).toContain("max-positions");
    expect(failedRules(evaluateRisk(input({ state: state({ entriesToday: 4 }) })))).toContain("entries-today");
    expect(failedRules(evaluateRisk(input({ state: state({ lastEntryAt: NOW - 3_600_000 }) })))).toContain("entry-spacing");
  });

  it("denies on daily loss and drawdown breaches", () => {
    expect(failedRules(evaluateRisk(input({ account: account({ equity: 9_600 }) })))).toContain("daily-loss");
    expect(failedRules(evaluateRisk(input({ account: account({ equity: 8_900 }), state: state({ dayStartEquity: 8_900 }) })))).toContain(
      "drawdown",
    );
  });

  it("denies a resting long above the mark or too far from it", () => {
    expect(failedRules(evaluateRisk(input({ plan: plan({ entry: { low: 79_600, high: 79_800, label: "x" } }) })))).toContain(
      "resting-entry-side",
    );
    expect(
      failedRules(
        evaluateRisk(
          input({
            plan: plan({ entry: { low: 74_000, high: 74_500, label: "x" }, stopLoss: { price: 73_000, label: "x" } }),
            candidate: candidate({ invalidation: { price: 73_500, label: "x" } }),
          }),
        ),
      ),
    ).toContain("resting-entry-distance");
  });

  it("denies when reward:risk after costs is below the minimum", () => {
    const d = evaluateRisk(input({ plan: plan({ takeProfit: { price: 79_000, label: "small" } }) }));
    expect(failedRules(d)).toContain("reward-risk");
  });

  it("denies when notional exceeds the depth fraction", () => {
    const d = evaluateRisk(input({ market: market({ depthNotionalNear: 10_000 }) }));
    expect(failedRules(d)).toContain("depth");
  });

  it("denies when adverse funding is extreme", () => {
    const d = evaluateRisk(input({ market: market({ fundingRateHourly: 0.001 }) }));
    expect(failedRules(d)).toContain("funding-not-extreme");
  });

  it("caps leverage: a tight stop cannot produce more than maxLeverage", () => {
    const d = evaluateRisk(
      input({
        plan: plan({
          entry: { low: 79_000, high: 79_100, label: "x" },
          stopLoss: { price: 78_700, label: "x" },
          takeProfit: { price: 80_500, label: "x" },
        }),
        candidate: candidate({ invalidation: { price: 78_800, label: "x" } }),
      }),
    );
    expect(d.order!.leverage).toBeLessThanOrEqual(5);
    expect(d.order!.notionalUsd).toBeLessThanOrEqual(50_000 + 1);
    // risk realised is below the 1% target because the leverage cap bit
    expect(d.order!.riskUsd).toBeLessThanOrEqual(100);
  });

  it("returns hold/no-op terminals for non-entry actions without sizing", () => {
    expect(evaluateRisk(input({ plan: plan({ action: "hold" }) })).terminal).toBe("hold");
    expect(evaluateRisk(input({ plan: plan({ action: "no-trade" }) })).terminal).toBe("no-op");
  });

  it("supports shorts symmetrically", () => {
    const d = evaluateRisk(
      input({
        plan: plan({
          direction: "short",
          entry: { low: 80_900, high: 81_400, label: "x" },
          stopLoss: { price: 83_200, label: "x" },
          takeProfit: { price: 76_000, label: "x" },
        }),
        candidate: candidate({ direction: "short", invalidation: { price: 83_000, label: "x" } }),
      }),
    );
    expect(failedRules(d)).toEqual([]);
    expect(d.order!.entryPrice).toBe(80_900);
    expect(d.order!.direction).toBe("short");
  });
});
