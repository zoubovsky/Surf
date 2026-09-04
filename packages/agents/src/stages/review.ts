import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CONFIDENCE_RANK, ReviewVerdict, type AnalystPrior, type Confidence, type EwAnalysis, type MarketContext, type TradePlan } from "@surf/core";
import { z } from "zod";
import { LlmOutputError } from "../errors.js";
import { reasoningFor } from "../models.js";
import { priorFreshness } from "../prompts/analyze.js";
import {
  buildReviewCoerceUserMessage,
  buildReviewUserMessage,
  SYSTEM_REVIEW,
  SYSTEM_REVIEW_COERCE,
  type ReviewInput,
  type ReviewPrechecks,
} from "../prompts/review.js";
import { systemBlocks } from "../prompts/shared.js";
import { finalize, lenientFormat } from "../schema-utils.js";
import { runParse, runToolRunner, stableStringify, type StageResult } from "../stage.js";
import type { ReviewerTools } from "../tools/reviewer-tools.js";
import { addTotals } from "../usage.js";
import type { StageDeps } from "./common.js";

export const REVIEW_MAX_TOKENS = 12_000;
export const REVIEW_MAX_ITERATIONS = 8;
export const REVIEW_COERCE_MAX_TOKENS = 4_000;

export type ReviewResult = StageResult<ReviewVerdict> & {
  findings: string;
  prechecks: ReviewPrechecks;
  /** Adjustments code applied on top of the model's verdict. */
  enforced: string[];
  iterations: number;
};

export const INDICATOR_NAMES: readonly string[] = Object.freeze([
  "rsi14",
  "rsidivergence",
  "atr14",
  "fundingratehourly",
  "funding",
  "openinteresttrend",
  "openinterest",
  "regime",
  "markprice",
  "depth",
]);

/**
 * Which evidence strings point at nothing in the inputs. A string is traceable if it mentions a
 * candidate id, the prior's video id, an indicator name, or a headline/event index that exists.
 */
export function untraceableEvidence(
  plan: TradePlan,
  ew: { h1: EwAnalysis; h4: EwAnalysis },
  prior: AnalystPrior | null,
  context: MarketContext,
): string[] {
  const ids = new Set([...ew.h1.candidates, ...ew.h4.candidates].map((c) => c.id.toLowerCase()));
  const videoId = prior?.videoId.toLowerCase() ?? null;
  return plan.evidence.filter((raw) => {
    const e = raw.toLowerCase();
    if ([...ids].some((id) => e.includes(id))) return false;
    if (videoId && e.includes(videoId)) return false;
    if (INDICATOR_NAMES.some((n) => e.replace(/[\s_-]/g, "").includes(n))) return false;
    const headline = /headline[:\s#-]*(\d+)/.exec(e);
    if (headline && Number(headline[1]) < context.headlines.length) return false;
    const event = /event[:\s#-]*(\d+)/.exec(e);
    if (event && Number(event[1]) < context.eventRisk.length) return false;
    return true;
  });
}

export function computePrechecks(input: ReviewInput): ReviewPrechecks {
  const now = input.market.asOf;
  const candidateExists =
    input.plan.candidateId === null ||
    [...input.ew.h1.candidates, ...input.ew.h4.candidates].some((c) => c.id === input.plan.candidateId);
  return {
    unknownEvidence: untraceableEvidence(input.plan, input.ew, input.prior, input.context),
    candidateExists,
    marketAgeSec: 0,
    accountAgeSec: Math.round((now - input.account.asOf) / 1000),
    candleAgeMin: input.market.lastCandleCloseTime === null ? null : Math.round((now - input.market.lastCandleCloseTime) / 60_000),
    priorFreshness: priorFreshness(input.prior, now, input.priorMaxAgeHours ?? 48),
  };
}

function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Code-enforced policy on the verdict: confidence never exceeds the plan's; untraceable evidence
 * flips evidenceTraceable and downgrades an approve to revise; a null R:R is filled from the tool.
 */
export function enforceVerdictPolicy(
  verdict: ReviewVerdict,
  plan: TradePlan,
  prechecks: ReviewPrechecks,
  recomputedRr: number | null,
): { verdict: ReviewVerdict; enforced: string[] } {
  const enforced: string[] = [];
  let out: ReviewVerdict = { ...verdict, checks: { ...verdict.checks }, reasons: [...verdict.reasons] };
  const clamped = minConfidence(out.adjustedConfidence, plan.confidence);
  if (clamped !== out.adjustedConfidence) {
    enforced.push(`adjustedConfidence clamped ${out.adjustedConfidence} -> ${clamped}`);
    out.adjustedConfidence = clamped;
  }
  if (prechecks.unknownEvidence.length > 0) {
    if (out.checks.evidenceTraceable) enforced.push("evidenceTraceable forced false");
    out.checks.evidenceTraceable = false;
    if (out.verdict === "approve") {
      out.verdict = "revise";
      out.severity = out.severity === "none" ? "minor" : out.severity;
      enforced.push("approve downgraded to revise: untraceable evidence");
      if (out.reasons.length < 12) out.reasons.push(`Untraceable evidence ids: ${prechecks.unknownEvidence.join(", ")}`.slice(0, 300));
    }
  }
  if (!prechecks.candidateExists && plan.action === "enter" && out.verdict !== "reject") {
    out.verdict = "reject";
    out.severity = "major";
    enforced.push("forced reject: candidate id not found");
    if (out.reasons.length < 12) out.reasons.push(`Candidate ${plan.candidateId} does not exist in the engine output`);
  }
  if (out.checks.rewardRiskRecomputed === null && recomputedRr !== null) {
    out.checks.rewardRiskRecomputed = recomputedRr;
    enforced.push("rewardRiskRecomputed filled from tool");
  }
  out = ReviewVerdict.parse(out);
  return { verdict: out, enforced };
}

/**
 * Independent Opus reviewer: adversarial system prompt, fresh context (plan + evidence, no analyst
 * reasoning chain), deterministic tools via the runner, then a structured-output coercion of the
 * findings. Code clamps and enforces afterwards.
 */
export async function review(deps: StageDeps, input: ReviewInput, tools: ReviewerTools): Promise<ReviewResult> {
  const prechecks = computePrechecks(input);
  const toolDefs = [
    betaZodTool({
      name: "get_candidate",
      description: "Return the deterministic Elliott Wave candidate with this id (1h or 4h), or null if it does not exist.",
      inputSchema: z.object({ id: z.string() }),
      run: ({ id }) => stableStringify(tools.getCandidate(id), 1),
    }),
    betaZodTool({
      name: "check_stop_vs_invalidation",
      description: "Deterministic check that the plan's stop is beyond the candidate invalidation, on the losing side of entry and inside the allowed stop-distance band.",
      inputSchema: z.object({}),
      run: () => stableStringify(tools.checkStopVsInvalidation(input.plan), 1),
    }),
    betaZodTool({
      name: "recompute_reward_risk",
      description: "Deterministic reward:risk after taker fees and expected funding, from the plan's worst-case entry, stop and target.",
      inputSchema: z.object({}),
      run: () => stableStringify(tools.recomputeRewardRisk(input.plan), 1),
    }),
    betaZodTool({
      name: "get_prior_levels",
      description: "The analyst prior's bias, invalidation, targets, entry zone, key levels and freshness, or null if no prior exists.",
      inputSchema: z.object({}),
      run: () => stableStringify(tools.getPriorLevels(), 1),
    }),
  ];
  const reasoning = reasoningFor(deps.model, "high");
  const runner = await runToolRunner(deps.client, "review", {
    model: deps.model,
    max_tokens: REVIEW_MAX_TOKENS,
    max_iterations: REVIEW_MAX_ITERATIONS,
    system: systemBlocks(SYSTEM_REVIEW),
    tools: toolDefs,
    messages: [buildReviewUserMessage(input, prechecks)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    ...(reasoning.effort ? { output_config: { effort: reasoning.effort } } : {}),
  });

  const coerceReasoning = reasoningFor(deps.model, "low");
  const coerced = await runParse(deps.client, "review-coerce", {
    model: deps.model,
    max_tokens: REVIEW_COERCE_MAX_TOKENS,
    system: systemBlocks(SYSTEM_REVIEW_COERCE),
    messages: [buildReviewCoerceUserMessage(runner.finalText, input.plan)],
    ...(coerceReasoning.thinking ? { thinking: coerceReasoning.thinking } : {}),
    output_config: { ...(coerceReasoning.effort ? { effort: coerceReasoning.effort } : {}), format: lenientFormat(ReviewVerdict) },
  });

  let raw: ReviewVerdict;
  try {
    raw = finalize(ReviewVerdict, coerced.output);
  } catch (err) {
    throw new LlmOutputError("review", err instanceof Error ? err.message : String(err));
  }
  const rr = input.plan.action === "enter" ? tools.recomputeRewardRisk(input.plan).rewardRisk : null;
  const { verdict, enforced } = enforceVerdictPolicy(raw, input.plan, prechecks, rr);
  return {
    output: verdict,
    usage: addTotals(runner.usage, coerced.usage),
    model: deps.model,
    promptHash: runner.promptHash,
    durationMs: runner.durationMs + coerced.durationMs,
    findings: runner.finalText,
    prechecks,
    enforced,
    iterations: runner.iterations,
  };
}
