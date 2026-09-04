import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { reasoningFor } from "../models.js";
import { buildTriageUserMessage, SYSTEM_TRIAGE } from "../prompts/triage.js";
import { systemBlocks } from "../prompts/shared.js";
import { runParse, type StageResult } from "../stage.js";
import { TriageResult } from "../types.js";
import type { StageDeps } from "./common.js";

export const TRIAGE_MAX_TOKENS = 512;

/** Haiku classifier: is this video Bitcoin Elliott Wave analysis worth extracting? */
export async function triage(deps: StageDeps, transcriptText: string, title: string): Promise<StageResult<TriageResult>> {
  const reasoning = reasoningFor(deps.model, "low");
  const run = await runParse(deps.client, "triage", {
    model: deps.model,
    max_tokens: TRIAGE_MAX_TOKENS,
    system: systemBlocks(SYSTEM_TRIAGE),
    messages: [buildTriageUserMessage(transcriptText, title)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: { ...(reasoning.effort ? { effort: reasoning.effort } : {}), format: zodOutputFormat(TriageResult) },
  });
  return { ...run, output: TriageResult.parse(run.output) };
}
