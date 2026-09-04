/** Canned LLM behaviour for daemon tests: every stage answers with a fixture-shaped object. */
import type { AnalystPrior, MarketContext, ReviewVerdict, TradePlan } from "@surf/core";
import {
  createFakeClient,
  fakeMessage,
  stageOf,
  type FakeLlmClient,
} from "../../../../packages/agents/src/testing/fake-client.js";
import { H } from "./harness.js";

export interface FakeLlmOptions {
  mark: number;
  now: number;
  videoId?: string;
  /** Override the analyst plan. */
  plan?: Partial<TradePlan>;
  verdict?: Partial<ReviewVerdict>;
  triage?: { relevant: boolean; isBitcoinAnalysis: boolean; substantive: boolean; reason: string };
}

export function cannedPlan(mark: number, over: Partial<TradePlan> = {}): TradePlan {
  return {
    action: "enter",
    direction: "long",
    candidateId: "1h-impulse-a",
    priorVideoId: null,
    setup: "wave-2-end",
    entry: { low: mark - 1_180, high: mark - 880, label: "fib zone" },
    entryKind: "limit",
    stopLoss: { price: mark - 2_980, label: "below W1 origin" },
    takeProfit: { price: mark + 3_720, label: "first target" },
    newStop: null,
    expectedHoldHours: 24,
    confidence: "high",
    evidence: ["1h-impulse-a", "4h-impulse-b", "rsiDivergence bullish"],
    priorDisagrees: false,
    rationale: "Wave-2-end long on 1h-impulse-a confirmed by 4h-impulse-b.",
    ...over,
  };
}

export function cannedVerdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    verdict: "approve",
    adjustedConfidence: "high",
    reasons: ["all checks pass"],
    checks: {
      dataFresh: true,
      evidenceTraceable: true,
      stopBeyondInvalidation: true,
      rewardRiskRecomputed: 2.1,
      priorConsistent: true,
      stateConsistent: true,
    },
    severity: "none",
    ...over,
  };
}

export function cannedContext(now: number): MarketContext {
  return {
    asOf: now,
    regime: "trending-up",
    fundingRateHourly: 0.0000118,
    fundingAssessment: "neutral",
    openInterestTrend: "rising",
    eventRisk: [{ when: now + 20 * H, description: "US CPI release", severity: "high" }],
    headlines: ["coindesk.com: spot ETF inflows continue"],
    brief: "BTC trending up on rising OI with neutral funding; CPI in 20h is the main event risk.",
  };
}

export function cannedPrior(mark: number, now: number, videoId: string): AnalystPrior {
  return {
    videoId,
    publishedAt: now - 6 * H,
    title: "x",
    asset: "BTC",
    bias: "long",
    timeframe: "1h, next few days",
    primaryCount: "wave 2 pullback of the impulse from 76k; wave 3 targets 83.5-84k",
    alternateCount: "loss of 77k opens a larger correction toward 72k",
    keyLevels: [{ price: 77_000, label: "wave 1 origin" }],
    invalidation: { price: 77_000, label: "below 77k" },
    targets: [{ price: 83_500, label: "wave 3 first target" }],
    entryZone: { low: 78_600, high: 78_900, label: "wave 2 zone" },
    confidence: "high",
    evidence: [
      "as long as we hold above 77,000 the count is valid and the invalidation is obviously at 77k",
      "the first target for wave three sits around 83,500 and then 84k above that",
      "pullback into the 78,600 to 78,900 area",
    ],
    summary: `Analyst sees a wave 2 pullback into 78.6-78.9k with invalidation at 77k and a first target at 83.5k (mark ${mark}).`,
  };
}

export function fakeLlm(o: FakeLlmOptions): FakeLlmClient {
  return createFakeClient({
    onToolRunner: () => [fakeMessage("notes")],
    onParse: (params) => {
      switch (stageOf(params)) {
        case "triage":
          return (
            o.triage ?? {
              relevant: true,
              isBitcoinAnalysis: true,
              substantive: true,
              reason: "BTC EW analysis with levels",
            }
          );
        case "extract-prior":
          return cannedPrior(o.mark, o.now, o.videoId ?? "vid");
        case "research-coerce":
          return cannedContext(o.now);
        case "analyze":
          return cannedPlan(o.mark, o.plan);
        case "review-coerce":
          return cannedVerdict(o.verdict);
        case "post-trade-review":
          return {
            decisionQuality: "good",
            outcome: "win",
            failureMode: null,
            lesson: {
              text: "Wave-2 entries at the 61.8% edge fill more reliably than the 50% edge.",
              evidenceTradeIds: ["seed"],
            },
            summary: "Clean wave-2 entry, target reached without excursion beyond 0.4R.",
          };
        case "daily-brief":
          return { brief: "Flat into the London open. One shadow trade closed at target." };
        case "answer-question":
          return { answer: "The last trade was a wave-2 long that hit its first target." };
        default:
          throw new Error(`fake llm: unexpected stage ${stageOf(params)}`);
      }
    },
  });
}
