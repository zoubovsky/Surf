import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { MarketContext } from "@surf/core";
import { z } from "zod";
import { LlmOutputError } from "../errors.js";
import { reasoningFor } from "../models.js";
import {
  buildResearchCoerceUserMessage,
  buildResearchUserMessage,
  marketNumbers,
  RESEARCH_ALLOWED_DOMAINS,
  RESEARCH_WEB_SEARCH_MAX_USES,
  SYSTEM_RESEARCH,
  SYSTEM_RESEARCH_COERCE,
  type ResearchInput,
} from "../prompts/research.js";
import { systemBlocks } from "../prompts/shared.js";
import { finalize, lenientFormat } from "../schema-utils.js";
import { runParse, runToolRunner, stableStringify, type StageResult } from "../stage.js";
import { addTotals } from "../usage.js";
import type { StageDeps } from "./common.js";

export const RESEARCH_MAX_TOKENS = 8_000;
export const RESEARCH_MAX_ITERATIONS = 8;
export const RESEARCH_COERCE_MAX_TOKENS = 4_000;

export type ResearchResult = StageResult<MarketContext> & {
  /** Plain-text notes the runner produced, kept for the journal. */
  notes: string;
  pausedTurns: number;
  iterations: number;
};

/** Server web search restricted to the allow-list; the beta runner accepts the literal object. */
export function researchWebSearchTool() {
  return {
    type: "web_search_20260209" as const,
    name: "web_search" as const,
    max_uses: RESEARCH_WEB_SEARCH_MAX_USES,
    allowed_domains: [...RESEARCH_ALLOWED_DOMAINS],
  };
}

/**
 * Sonnet researcher: tool runner (get_market_numbers + allow-listed web search) producing plain
 * notes, then a structured-output call coercing the notes into MarketContext. Never opines on
 * direction; the schema has no direction field to opine in.
 */
export async function research(deps: StageDeps, input: ResearchInput): Promise<ResearchResult> {
  const numbers = marketNumbers(input);
  const getMarketNumbers = betaZodTool({
    name: "get_market_numbers",
    description:
      "Returns the exact market snapshot, funding-rate history and open-interest history the system holds for BTC-USD. Use these numbers verbatim; do not search the web for them.",
    inputSchema: z.object({}),
    run: () => stableStringify(numbers, 1),
  });
  const reasoning = reasoningFor(deps.model, "medium");
  const runner = await runToolRunner(deps.client, "research", {
    model: deps.model,
    max_tokens: RESEARCH_MAX_TOKENS,
    max_iterations: RESEARCH_MAX_ITERATIONS,
    system: systemBlocks(SYSTEM_RESEARCH),
    tools: [getMarketNumbers, researchWebSearchTool()],
    messages: [buildResearchUserMessage(input)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    ...(reasoning.effort ? { output_config: { effort: reasoning.effort } } : {}),
  });

  const coerceReasoning = reasoningFor(deps.model, "low");
  const coerced = await runParse(deps.client, "research-coerce", {
    model: deps.model,
    max_tokens: RESEARCH_COERCE_MAX_TOKENS,
    system: systemBlocks(SYSTEM_RESEARCH_COERCE),
    messages: [buildResearchCoerceUserMessage(runner.finalText, input.market.asOf)],
    ...(coerceReasoning.thinking ? { thinking: coerceReasoning.thinking } : {}),
    output_config: {
      ...(coerceReasoning.effort ? { effort: coerceReasoning.effort } : {}),
      format: lenientFormat(MarketContext),
    },
  });

  let context: MarketContext;
  try {
    context = finalize(MarketContext, {
      ...(coerced.output as Record<string, unknown>),
      asOf: input.market.asOf,
      fundingRateHourly: input.market.fundingRateHourly,
    });
  } catch (err) {
    throw new LlmOutputError("research", err instanceof Error ? err.message : String(err));
  }
  return {
    output: context,
    usage: addTotals(runner.usage, coerced.usage),
    model: deps.model,
    promptHash: runner.promptHash,
    durationMs: runner.durationMs + coerced.durationMs,
    notes: runner.finalText,
    pausedTurns: runner.pausedTurns,
    iterations: runner.iterations,
  };
}
