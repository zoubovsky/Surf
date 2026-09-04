import type { ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Defaults mirror AppConfig in @surf/core; the daemon passes the configured ids in. */
export const DEFAULT_MODELS = Object.freeze({
  triage: "claude-haiku-4-5",
  researcher: "claude-sonnet-5",
  analyst: "claude-opus-5",
  reviewer: "claude-opus-5",
});
export type StageModels = { -readonly [K in keyof typeof DEFAULT_MODELS]: string };

/** Models that accept adaptive thinking + output_config.effort (no budget_tokens). */
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus-5|sonnet-5|fable-5|mythos-5|opus-4-[678]|sonnet-4-6)/.test(model);
}

/** Models that accept a `{ role: "system" }` message appended to `messages` (no beta header). */
export function supportsMidConversationSystem(model: string): boolean {
  return /^claude-(opus-5|opus-4-8|fable-5|mythos-5)/.test(model);
}

export interface ReasoningParams {
  thinking?: ThinkingConfigParam;
  effort?: Effort;
}

/**
 * Reasoning parameters per model family. Claude 5 / 4.6+ models take adaptive thinking and an
 * effort level; Haiku 4.5 gets neither (budget_tokens would need max_tokens > 1024 and effort is
 * rejected there). Never emits budget_tokens.
 */
export function reasoningFor(model: string, effort: Effort): ReasoningParams {
  if (/^claude-haiku/.test(model)) return {};
  if (supportsAdaptiveThinking(model)) return { thinking: { type: "adaptive" }, effort };
  // Unknown or newer model: adaptive thinking is the forward-compatible default.
  return { thinking: { type: "adaptive" }, effort };
}
