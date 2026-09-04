import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { reasoningFor } from "../models.js";
import { buildAnswerUserMessage, SYSTEM_ANSWER } from "../prompts/answer.js";
import { clip, systemBlocks } from "../prompts/shared.js";
import { runParse, type StageResult } from "../stage.js";
import { AnswerQuestionInput } from "../types.js";
import type { StageDeps } from "./common.js";

export const ANSWER_MAX_TOKENS = 2_000;
export const ANSWER_MAX_CHARS = 1_200;
const AnswerOut = z.object({ answer: z.string() });

/** Sonnet: answer an operator question from read-only context. No tools. */
export async function answerQuestion(deps: StageDeps, rawInput: AnswerQuestionInput): Promise<StageResult<string>> {
  const input = AnswerQuestionInput.parse(rawInput);
  const reasoning = reasoningFor(deps.model, "low");
  const run = await runParse(deps.client, "answer-question", {
    model: deps.model,
    max_tokens: ANSWER_MAX_TOKENS,
    system: systemBlocks(SYSTEM_ANSWER),
    messages: [buildAnswerUserMessage(input)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: { ...(reasoning.effort ? { effort: reasoning.effort } : {}), format: zodOutputFormat(AnswerOut) },
  });
  return { ...run, output: clip(run.output.answer.trim(), ANSWER_MAX_CHARS) };
}
