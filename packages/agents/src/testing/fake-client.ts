import type { MessageCountTokensParams, RefusalStopDetails, StopReason } from "@anthropic-ai/sdk/resources/messages";
import type { LlmClient, LlmMessage, LlmParsed, LlmParseParams, LlmToolRunner, LlmToolRunnerParams } from "../client.js";
import { SYSTEM_ANALYZE } from "../prompts/analyze.js";
import { SYSTEM_ANSWER } from "../prompts/answer.js";
import { SYSTEM_DAILY_BRIEF } from "../prompts/daily-brief.js";
import { SYSTEM_EXTRACT_PRIOR } from "../prompts/extract-prior.js";
import { SYSTEM_POST_TRADE } from "../prompts/post-trade.js";
import { SYSTEM_RESEARCH, SYSTEM_RESEARCH_COERCE } from "../prompts/research.js";
import { SYSTEM_REVIEW, SYSTEM_REVIEW_COERCE } from "../prompts/review.js";
import { SYSTEM_TRIAGE } from "../prompts/triage.js";
import type { LlmUsage } from "../usage.js";

/**
 * In-memory LlmClient for tests. `parse` runs the handler's output through the request's own
 * output format (the same Zod validation the SDK performs), so schema round-trips are exercised.
 */

export const DEFAULT_FAKE_USAGE: LlmUsage = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export interface FakeParseResponse {
  __fakeResponse: true;
  output?: unknown;
  stop_reason?: StopReason;
  stop_details?: RefusalStopDetails | null;
  usage?: LlmUsage;
  model?: string;
}

export function fakeResponse(spec: Omit<FakeParseResponse, "__fakeResponse">): FakeParseResponse {
  return { __fakeResponse: true, ...spec };
}

function isFakeResponse(x: unknown): x is FakeParseResponse {
  return !!x && typeof x === "object" && (x as FakeParseResponse).__fakeResponse === true;
}

export type FakeParseHandler = (params: LlmParseParams<unknown>, index: number) => unknown | Promise<unknown>;
export type FakeRunnerHandler = (params: LlmToolRunnerParams, index: number) => LlmMessage[] | Promise<LlmMessage[]>;

export function fakeMessage(text: string, opts: { stop_reason?: StopReason; usage?: LlmUsage; model?: string } = {}): LlmMessage {
  return {
    content: [{ type: "text", text, citations: null }],
    stop_reason: opts.stop_reason ?? "end_turn",
    stop_details: null,
    usage: opts.usage ?? DEFAULT_FAKE_USAGE,
    model: opts.model ?? "fake",
  };
}

export interface FakeParseCall {
  index: number;
  params: LlmParseParams<unknown>;
}
export interface FakeRunnerCall {
  index: number;
  params: LlmToolRunnerParams;
  messages: LlmMessage[];
}

export interface FakeLlmClient extends LlmClient {
  parseCalls: FakeParseCall[];
  runnerCalls: FakeRunnerCall[];
  /** Messages the stage asked to resume after a pause_turn. */
  resumed: LlmMessage[];
}

export function createFakeClient(opts: { onParse?: FakeParseHandler; onToolRunner?: FakeRunnerHandler; tokenCount?: number } = {}): FakeLlmClient {
  const parseCalls: FakeParseCall[] = [];
  const runnerCalls: FakeRunnerCall[] = [];
  const resumed: LlmMessage[] = [];
  return {
    parseCalls,
    runnerCalls,
    resumed,
    async parse<T>(params: LlmParseParams<T>): Promise<LlmParsed<T>> {
      const index = parseCalls.length;
      parseCalls.push({ index, params: params as LlmParseParams<unknown> });
      if (!opts.onParse) throw new Error(`fake client: no onParse handler (model ${params.model})`);
      const result = await opts.onParse(params as LlmParseParams<unknown>, index);
      const spec: FakeParseResponse = isFakeResponse(result) ? result : { __fakeResponse: true, output: result };
      const stop = spec.stop_reason ?? "end_turn";
      const parsed =
        stop === "refusal" || stop === "max_tokens" || spec.output === undefined
          ? null
          : (params.output_config.format.parse(JSON.stringify(spec.output)) as T);
      return {
        parsed_output: parsed,
        stop_reason: stop,
        stop_details: spec.stop_details ?? null,
        usage: spec.usage ?? DEFAULT_FAKE_USAGE,
        model: spec.model ?? params.model,
        content: parsed === null ? [] : [{ type: "text", text: JSON.stringify(spec.output), citations: null }],
      };
    },
    toolRunner(params: LlmToolRunnerParams): LlmToolRunner {
      const index = runnerCalls.length;
      if (!opts.onToolRunner) throw new Error(`fake client: no onToolRunner handler (model ${params.model})`);
      const call: FakeRunnerCall = { index, params, messages: [] };
      runnerCalls.push(call);
      const pending = Promise.resolve(opts.onToolRunner(params, index));
      return {
        async *[Symbol.asyncIterator]() {
          call.messages = await pending;
          for (const m of call.messages) yield m;
        },
        resumePausedTurn(m: LlmMessage) {
          resumed.push(m);
        },
        async done() {
          const last = (await pending).at(-1);
          if (!last) throw new Error("fake runner has no messages");
          return last;
        },
      };
    },
    async countTokens(_params: MessageCountTokensParams): Promise<number> {
      return opts.tokenCount ?? 1_000;
    },
  };
}

const STAGE_BY_SYSTEM: ReadonlyArray<[string, string]> = [
  [SYSTEM_TRIAGE, "triage"],
  [SYSTEM_EXTRACT_PRIOR, "extract-prior"],
  [SYSTEM_RESEARCH, "research"],
  [SYSTEM_RESEARCH_COERCE, "research-coerce"],
  [SYSTEM_ANALYZE, "analyze"],
  [SYSTEM_REVIEW, "review"],
  [SYSTEM_REVIEW_COERCE, "review-coerce"],
  [SYSTEM_POST_TRADE, "post-trade-review"],
  [SYSTEM_DAILY_BRIEF, "daily-brief"],
  [SYSTEM_ANSWER, "answer-question"],
];

/** Identify which stage built a request by its frozen system prompt. */
export function stageOf(params: { system?: string | Array<{ text: string }> | undefined }): string {
  const text = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("\n");
  for (const [sys, name] of STAGE_BY_SYSTEM) if (text === sys) return name;
  return "unknown";
}
