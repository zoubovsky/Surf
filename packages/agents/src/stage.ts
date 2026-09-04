import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { LlmClient, LlmMessage, LlmParseParams, LlmToolRunner, LlmToolRunnerParams } from "./client.js";
import { LlmOutputError, LlmRefusalError, LlmTruncatedError } from "./errors.js";
import { UsageMeter, type UsageTotals } from "./usage.js";

/** Every stage returns this envelope so the journal can attribute cost, model and prompt version. */
export interface StageResult<T> {
  output: T;
  usage: UsageTotals;
  model: string;
  /** sha256 (16 hex) of the frozen system prompt: identifies the prompt template version. */
  promptHash: string;
  durationMs: number;
}

export function hashPrompt(system: string | TextBlockParam[]): string {
  const text = typeof system === "string" ? system : system.map((b) => b.text).join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** JSON with sorted keys so identical data renders to identical bytes (cache-friendly, hashable). */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export interface ParseRun<T> {
  output: T;
  usage: UsageTotals;
  model: string;
  promptHash: string;
  durationMs: number;
}

/** Run one structured-output call with uniform refusal / truncation / null-output handling. */
export async function runParse<T>(
  client: LlmClient,
  stage: string,
  params: LlmParseParams<T>,
): Promise<ParseRun<T>> {
  const started = performance.now();
  const res = await client.parse(params);
  const durationMs = Math.round(performance.now() - started);
  const meter = new UsageMeter();
  const usage = meter.add(params.model, res.usage);
  if (res.stop_reason === "refusal") {
    throw new LlmRefusalError(
      stage,
      res.stop_details?.category ?? null,
      res.stop_details?.explanation ?? null,
    );
  }
  if (res.stop_reason === "max_tokens") throw new LlmTruncatedError(stage);
  if (res.parsed_output === null || res.parsed_output === undefined) {
    throw new LlmOutputError(stage, `parsed_output is null (stop_reason=${res.stop_reason ?? "null"})`);
  }
  return {
    output: res.parsed_output,
    usage,
    model: params.model,
    promptHash: hashPrompt(params.system ?? ""),
    durationMs,
  };
}

export interface RunnerRun {
  final: LlmMessage;
  finalText: string;
  usage: UsageTotals;
  model: string;
  promptHash: string;
  durationMs: number;
  /** Number of `pause_turn` stops that were resumed. */
  pausedTurns: number;
  iterations: number;
}

/**
 * Drive a tool runner to completion, folding every iteration's usage into the total and resuming
 * paused server-tool turns. A refusal anywhere aborts the stage.
 */
export async function runToolRunner(
  client: LlmClient,
  stage: string,
  params: LlmToolRunnerParams,
): Promise<RunnerRun> {
  const started = performance.now();
  const meter = new UsageMeter();
  const runner: LlmToolRunner = client.toolRunner(params);
  let pausedTurns = 0;
  let iterations = 0;
  for await (const message of runner) {
    iterations++;
    meter.add(params.model, message.usage);
    if (message.stop_reason === "refusal") {
      throw new LlmRefusalError(
        stage,
        message.stop_details?.category ?? null,
        message.stop_details?.explanation ?? null,
      );
    }
    if (message.stop_reason === "pause_turn") {
      pausedTurns++;
      runner.resumePausedTurn(message);
    }
  }
  const final = await runner.done();
  const finalText = textOf(final);
  if (finalText.trim().length === 0) {
    throw new LlmOutputError(
      stage,
      `tool runner ended with no text (stop_reason=${final.stop_reason ?? "null"})`,
    );
  }
  return {
    final,
    finalText,
    usage: meter.totals,
    model: params.model,
    promptHash: hashPrompt(params.system ?? ""),
    durationMs: Math.round(performance.now() - started),
    pausedTurns,
    iterations,
  };
}

export function textOf(message: { content: ReadonlyArray<{ type: string }> }): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
