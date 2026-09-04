import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { TradePlan } from "@surf/core";
import { LlmOutputError } from "../errors.js";
import { reasoningFor, supportsMidConversationSystem } from "../models.js";
import {
  buildAnalyzeUserMessage,
  renderRevisionFeedback,
  SYSTEM_ANALYZE,
  type AnalyzeInput,
  type RevisionFeedback,
} from "../prompts/analyze.js";
import { systemBlocks } from "../prompts/shared.js";
import { finalize, lenientFormat } from "../schema-utils.js";
import { runParse, type StageResult } from "../stage.js";
import type { StageDeps } from "./common.js";

export const ANALYZE_MAX_TOKENS = 16_000;

export interface AnalyzeOptions {
  /** Reviewer objections from a previous round of the revise loop. */
  revision?: RevisionFeedback;
}

/**
 * Build the message list. Reviewer feedback rides the operator channel (`role: "system"` appended
 * after the user turn) on models that support it, so the cached prefix is untouched and the text
 * cannot be confused with input data; elsewhere it is a clearly tagged block in a second user turn.
 */
export function analyzeMessages(
  model: string,
  input: AnalyzeInput,
  revision?: RevisionFeedback,
): MessageParam[] {
  const messages: MessageParam[] = [buildAnalyzeUserMessage(input)];
  if (revision) {
    const text = renderRevisionFeedback(revision);
    if (supportsMidConversationSystem(model)) messages.push({ role: "system", content: text });
    else
      messages.push({
        role: "user",
        content: `<reviewer_revision_request>\n${text}\n</reviewer_revision_request>`,
      });
  }
  return messages;
}

/** Deterministic post-conditions the schema cannot express. Returns a list of violations. */
export function planInvariantViolations(plan: TradePlan): string[] {
  const v: string[] = [];
  if (plan.action === "enter") {
    for (const f of [
      "direction",
      "candidateId",
      "setup",
      "entry",
      "entryKind",
      "stopLoss",
      "takeProfit",
      "expectedHoldHours",
    ] as const) {
      if (plan[f] === null) v.push(`enter plan missing ${f}`);
    }
    if (plan.setup && !["wave-2-end", "wave-4-end", "wave-c-end"].includes(plan.setup))
      v.push(`setup ${plan.setup} is not an entry setup`);
    if (plan.entry && plan.entry.low > plan.entry.high) v.push("entry zone low > high");
  }
  if (plan.action === "adjust-stop" && plan.newStop === null) v.push("adjust-stop without newStop");
  return v;
}

/** Opus analyst: one TradePlan from the deterministic count, the prior, context and state. */
export async function analyze(
  deps: StageDeps,
  input: AnalyzeInput,
  opts: AnalyzeOptions = {},
): Promise<StageResult<TradePlan>> {
  const reasoning = reasoningFor(deps.model, "high");
  const run = await runParse(deps.client, "analyze", {
    model: deps.model,
    max_tokens: ANALYZE_MAX_TOKENS,
    system: systemBlocks(SYSTEM_ANALYZE),
    messages: analyzeMessages(deps.model, input, opts.revision),
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: {
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      format: lenientFormat(TradePlan),
    },
  });
  let plan: TradePlan;
  try {
    plan = finalize(TradePlan, run.output);
  } catch (err) {
    throw new LlmOutputError("analyze", err instanceof Error ? err.message : String(err));
  }
  const violations = planInvariantViolations(plan);
  if (violations.length > 0) throw new LlmOutputError("analyze", violations.join("; "));
  return { ...run, output: plan };
}
