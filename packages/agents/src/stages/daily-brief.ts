import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { reasoningFor } from "../models.js";
import {
  buildDailyBriefUserMessage,
  DAILY_BRIEF_MAX_CHARS,
  SYSTEM_DAILY_BRIEF,
} from "../prompts/daily-brief.js";
import { clip, systemBlocks } from "../prompts/shared.js";
import { runParse, type StageResult } from "../stage.js";
import { DailyBriefInput } from "../types.js";
import type { StageDeps } from "./common.js";

export const DAILY_BRIEF_MAX_TOKENS = 2_000;
const BriefOut = z.object({ brief: z.string() });

/** Sonnet: plain-prose daily brief (<= 1200 chars). The daemon wraps it in Telegram HTML. */
export async function dailyBrief(deps: StageDeps, rawInput: DailyBriefInput): Promise<StageResult<string>> {
  const input = DailyBriefInput.parse(rawInput);
  const reasoning = reasoningFor(deps.model, "low");
  const run = await runParse(deps.client, "daily-brief", {
    model: deps.model,
    max_tokens: DAILY_BRIEF_MAX_TOKENS,
    system: systemBlocks(SYSTEM_DAILY_BRIEF),
    messages: [buildDailyBriefUserMessage(input)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: {
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      format: zodOutputFormat(BriefOut),
    },
  });
  return { ...run, output: clip(run.output.brief.trim(), DAILY_BRIEF_MAX_CHARS) };
}
