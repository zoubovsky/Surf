import { AnalystPrior } from "@surf/core";
import { LlmOutputError } from "../errors.js";
import { reasoningFor } from "../models.js";
import { buildExtractPriorUserMessage, SYSTEM_EXTRACT_PRIOR } from "../prompts/extract-prior.js";
import { systemBlocks } from "../prompts/shared.js";
import { finalize, lenientFormat } from "../schema-utils.js";
import { runParse, type StageResult } from "../stage.js";
import { ExtractPriorInput, type EvidenceReport, type ExtractPriorInputRaw } from "../types.js";
import { verifyEvidence } from "../verify-evidence.js";
import type { StageDeps } from "./common.js";

export const EXTRACT_PRIOR_MAX_TOKENS = 16_000;

export type ExtractPriorResult = StageResult<AnalystPrior> & { verification: EvidenceReport };

/** Opus extraction of the analyst prior, followed by deterministic evidence verification. */
export async function extractPrior(deps: StageDeps, rawInput: ExtractPriorInputRaw): Promise<ExtractPriorResult> {
  const input = ExtractPriorInput.parse(rawInput);
  const reasoning = reasoningFor(deps.model, "high");
  const run = await runParse(deps.client, "extract-prior", {
    model: deps.model,
    max_tokens: EXTRACT_PRIOR_MAX_TOKENS,
    system: systemBlocks(SYSTEM_EXTRACT_PRIOR),
    messages: [buildExtractPriorUserMessage(input)],
    ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
    output_config: { ...(reasoning.effort ? { effort: reasoning.effort } : {}), format: lenientFormat(AnalystPrior) },
  });
  let parsed: AnalystPrior;
  try {
    parsed = finalize(AnalystPrior, {
      ...(run.output as Record<string, unknown>),
      // Identity fields come from our own metadata, never from the model.
      videoId: input.videoId,
      title: input.title,
      publishedAt: input.publishedAt,
      asset: "BTC",
    });
  } catch (err) {
    throw new LlmOutputError("extract-prior", err instanceof Error ? err.message : String(err));
  }
  const { prior, report } = verifyEvidence(parsed, input.transcriptText);
  return { ...run, output: prior, verification: report };
}
