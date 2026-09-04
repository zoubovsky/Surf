import { LlmOutputError } from "../errors.js";
import { reasoningFor } from "../models.js";
import { buildPostTradeUserMessage, SYSTEM_POST_TRADE } from "../prompts/post-trade.js";
import { systemBlocks } from "../prompts/shared.js";
import { finalize, lenientFormat } from "../schema-utils.js";
import { runParse, type StageResult } from "../stage.js";
import { PostTradeReviewInput, PostTradeReviewOutput, type PostTradeReviewInputRaw } from "../types.js";
import type { StageDeps } from "./common.js";

export const POST_TRADE_MAX_TOKENS = 8_000;

/** Opus post-trade review: decision quality vs outcome, one failure mode, at most one lesson. */
export async function postTradeReview(
  deps: StageDeps,
  rawInput: PostTradeReviewInputRaw,
): Promise<StageResult<PostTradeReviewOutput>> {
  const input = PostTradeReviewInput.parse(rawInput);
  const reasoning = reasoningFor(deps.model, "medium");
  const run = await runParse(deps.client, "post-trade-review", {
    model: deps.model,
    max_tokens: POST_TRADE_MAX_TOKENS,
    system: systemBlocks(SYSTEM_POST_TRADE),
    messages: [buildPostTradeUserMessage(input)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: {
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      format: lenientFormat(PostTradeReviewOutput),
    },
  });
  let out: PostTradeReviewOutput;
  try {
    out = finalize(PostTradeReviewOutput, run.output);
  } catch (err) {
    throw new LlmOutputError("post-trade-review", err instanceof Error ? err.message : String(err));
  }
  // A lesson must rest on at least the trade it was learned from.
  if (out.lesson && !out.lesson.evidenceTradeIds.includes(input.journalEntry.tradeId)) {
    out = {
      ...out,
      lesson: {
        ...out.lesson,
        evidenceTradeIds: [input.journalEntry.tradeId, ...out.lesson.evidenceTradeIds].slice(0, 10),
      },
    };
  }
  return { ...run, output: out };
}
