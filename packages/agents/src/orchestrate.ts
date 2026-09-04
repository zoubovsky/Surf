import type { AccountSnapshot, AnalystPrior, EwAnalysis, MarketContext, MarketSnapshot, ReviewVerdict, RiskLimits, TradePlan, TradingState } from "@surf/core";
import type { LlmClient } from "./client.js";
import type { ResearchInput } from "./prompts/research.js";
import { analyze } from "./stages/analyze.js";
import { research } from "./stages/research.js";
import { review } from "./stages/review.js";
import { createReviewerTools, type ReviewerTools } from "./tools/reviewer-tools.js";
import type { CalibrationSummary, OpenPositionContext, StageRecord } from "./types.js";
import { addTotals, ZERO_USAGE, type UsageTotals } from "./usage.js";

export const MAX_REVISIONS = 2;

export interface DecisionDeps {
  client: LlmClient;
  models: { researcher: string; analyst: string; reviewer: string };
  /** Hard USD cap for this cycle's LLM spend. Exceeding it ends the cycle with terminal "exhausted". */
  budgetUsd: number;
  /** Override the deterministic reviewer helpers (tests, or a caller with richer data). */
  reviewerTools?: (inputs: DecisionInputs) => ReviewerTools;
  /** Skip the reviewer for "no-trade" plans (nothing to execute). Default true. */
  skipReviewForNoTrade?: boolean;
  /** Reuse an already-computed context instead of running the researcher. */
  context?: MarketContext;
  priorMaxAgeHours?: number;
}

export interface DecisionInputs {
  ew: { h1: EwAnalysis; h4: EwAnalysis };
  prior: AnalystPrior | null;
  account: AccountSnapshot;
  market: MarketSnapshot;
  state: TradingState;
  limits: RiskLimits;
  calibration: CalibrationSummary | null;
  lessons: string[];
  openPosition?: OpenPositionContext | null;
  research: Omit<ResearchInput, "market">;
}

export type DecisionTerminal = "approved" | "rejected" | "exhausted";

export interface DecisionRun {
  plan: TradePlan | null;
  /** Null only when the reviewer was skipped (no-trade) or never reached (budget). */
  review: ReviewVerdict | null;
  context: MarketContext | null;
  stages: StageRecord[];
  totalUsage: UsageTotals;
  terminal: DecisionTerminal;
  /** Why the run ended, for the journal and Telegram. */
  reason: string;
  revisions: number;
}

/**
 * research -> analyze -> review with a bounded revise loop. Every stage is journaled; the USD
 * budget is checked after each stage. "exhausted" (budget or revisions) is never success.
 */
export async function runDecisionStages(deps: DecisionDeps, inputs: DecisionInputs): Promise<DecisionRun> {
  const stages: StageRecord[] = [];
  let total: UsageTotals = { ...ZERO_USAGE };
  const record = (r: StageRecord) => {
    stages.push(r);
    total = addTotals(total, r.usage);
  };
  const overBudget = () => total.costUsd > deps.budgetUsd;
  const finish = (partial: Omit<DecisionRun, "stages" | "totalUsage">): DecisionRun => ({ ...partial, stages, totalUsage: total });
  const priorMaxAgeHours = deps.priorMaxAgeHours ?? 48;

  let context: MarketContext;
  if (deps.context) {
    context = deps.context;
  } else {
    const r = await research({ client: deps.client, model: deps.models.researcher }, { ...inputs.research, market: inputs.market });
    record({ stage: "research", round: 0, model: r.model, promptHash: r.promptHash, usage: r.usage, durationMs: r.durationMs, output: r.output });
    context = r.output;
    if (overBudget()) {
      return finish({ plan: null, review: null, context, terminal: "exhausted", reason: budgetReason(total, deps.budgetUsd, "research"), revisions: 0 });
    }
  }

  const analyzeInput = {
    ew: inputs.ew,
    prior: inputs.prior,
    context,
    account: inputs.account,
    market: inputs.market,
    state: inputs.state,
    limits: inputs.limits,
    calibration: inputs.calibration,
    lessons: inputs.lessons,
    openPosition: inputs.openPosition ?? null,
    priorMaxAgeHours,
  };
  const tools = (deps.reviewerTools ?? defaultReviewerTools)(inputs);
  const reviewOpenPosition = inputs.openPosition
    ? {
        direction: inputs.openPosition.direction,
        entryPrice: inputs.openPosition.entryPrice,
        stopLoss: inputs.openPosition.stopLoss,
        takeProfit: inputs.openPosition.takeProfit,
      }
    : null;

  let plan: TradePlan | null = null;
  let verdict: ReviewVerdict | null = null;
  let revisions = 0;
  for (let round = 0; round <= MAX_REVISIONS; round++) {
    const a = await analyze(
      { client: deps.client, model: deps.models.analyst },
      analyzeInput,
      verdict ? { revision: { round, review: verdict } } : {},
    );
    record({ stage: "analyze", round, model: a.model, promptHash: a.promptHash, usage: a.usage, durationMs: a.durationMs, output: a.output });
    plan = a.output;
    if (overBudget()) {
      return finish({ plan, review: verdict, context, terminal: "exhausted", reason: budgetReason(total, deps.budgetUsd, "analyze"), revisions });
    }

    if (plan.action === "no-trade" && (deps.skipReviewForNoTrade ?? true)) {
      return finish({ plan, review: null, context, terminal: "approved", reason: "no-trade plan; reviewer skipped by policy", revisions });
    }

    const rv = await review(
      { client: deps.client, model: deps.models.reviewer },
      { plan, ew: inputs.ew, prior: inputs.prior, context, account: inputs.account, market: inputs.market, state: inputs.state, limits: inputs.limits, openPosition: reviewOpenPosition, priorMaxAgeHours },
      tools,
    );
    record({
      stage: "review",
      round,
      model: rv.model,
      promptHash: rv.promptHash,
      usage: rv.usage,
      durationMs: rv.durationMs,
      output: { verdict: rv.output, findings: rv.findings, prechecks: rv.prechecks, enforced: rv.enforced },
    });
    verdict = rv.output;
    if (overBudget()) {
      return finish({ plan, review: verdict, context, terminal: "exhausted", reason: budgetReason(total, deps.budgetUsd, "review"), revisions });
    }

    if (verdict.verdict === "approve") {
      return finish({ plan, review: verdict, context, terminal: "approved", reason: `reviewer approved after ${revisions} revision(s)`, revisions });
    }
    if (verdict.verdict === "reject") {
      return finish({ plan, review: verdict, context, terminal: "rejected", reason: `reviewer rejected: ${verdict.reasons[0] ?? "no reason given"}`, revisions });
    }
    if (round === MAX_REVISIONS) break;
    revisions++;
  }
  return finish({
    plan,
    review: verdict,
    context,
    terminal: "exhausted",
    reason: `reviewer still asked for revision after ${MAX_REVISIONS} revisions`,
    revisions,
  });
}

function defaultReviewerTools(inputs: DecisionInputs): ReviewerTools {
  return createReviewerTools({ ew: inputs.ew, prior: inputs.prior, market: inputs.market, limits: inputs.limits });
}

function budgetReason(total: UsageTotals, budget: number, stage: string): string {
  return `LLM budget exceeded after ${stage}: $${total.costUsd.toFixed(3)} > $${budget.toFixed(2)}`;
}
