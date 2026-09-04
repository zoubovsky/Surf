import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming,
  RefusalStopDetails,
  StopReason,
} from "@anthropic-ai/sdk/resources/messages";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages";
import type { BetaToolRunner, BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";
import type { Effort } from "./models.js";
import type { LlmUsage } from "./usage.js";

/**
 * The slice of the Anthropic SDK the stages use. Stages depend on this interface only, so tests
 * inject a fake and production injects `createAnthropic(...)`.
 */
export interface LlmClient {
  parse<T>(params: LlmParseParams<T>): Promise<LlmParsed<T>>;
  toolRunner(params: LlmToolRunnerParams): LlmToolRunner;
  countTokens(params: MessageCountTokensParams): Promise<number>;
}

export type LlmParseParams<T> = Omit<MessageCreateParamsNonStreaming, "output_config"> & {
  output_config: { effort?: Effort; format: AutoParseableOutputFormat<T> };
};

/** What a structured-output call returns; a subset of the SDK's ParsedMessage. */
export interface LlmParsed<T> {
  parsed_output: T | null;
  stop_reason: StopReason | null;
  stop_details: RefusalStopDetails | null;
  usage: LlmUsage;
  model: string;
  content: ContentBlock[];
}

export type LlmToolRunnerParams = BetaToolRunnerParams;

/** One assistant message from a tool-runner iteration; a subset of BetaMessage. */
export interface LlmMessage {
  content: BetaMessage["content"];
  stop_reason: BetaMessage["stop_reason"];
  stop_details?: BetaMessage["stop_details"];
  usage: LlmUsage;
  model: string;
}

export interface LlmToolRunner extends AsyncIterable<LlmMessage> {
  /**
   * Called by stages on every `pause_turn` message. The SDK adapter decides whether the paused
   * assistant turn must be pushed back (older SDKs) or whether the runner resumes on its own.
   */
  resumePausedTurn(message: LlmMessage): void;
  /** Final assistant message after iteration completes. */
  done(): Promise<LlmMessage>;
}

export interface CreateAnthropicOptions {
  apiKey: string;
  /** Default 3. */
  maxRetries?: number;
  /** Request timeout in ms. Default 10 minutes (Opus with high effort can think for a while). */
  timeout?: number;
}

/** Production client: the SDK with retries, wrapped to the LlmClient surface. */
export function createAnthropic(opts: CreateAnthropicOptions): LlmClient {
  const sdk = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries ?? 3,
    timeout: opts.timeout ?? 10 * 60_000,
  });
  return wrapAnthropic(sdk);
}

class SdkToolRunner implements LlmToolRunner {
  constructor(private readonly inner: BetaToolRunner<false>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<LlmMessage> {
    for await (const message of this.inner) yield message;
  }

  resumePausedTurn(_message: LlmMessage): void {
    // @anthropic-ai/sdk >= 0.123 classifies `pause_turn` as "resume": the runner re-appends the
    // paused assistant turn and re-sends it itself (see lib/tools/BetaToolRunner
    // determineNextStepFromStopReason). Pushing the turn again here would duplicate it. Older
    // SDKs (<= 0.110) needed `inner.pushMessages({ role: "assistant", content })` at this point.
  }

  done(): Promise<LlmMessage> {
    return this.inner.done();
  }
}

/** Adapt an SDK instance (or a structural stub in tests) to LlmClient. */
export function wrapAnthropic(sdk: Anthropic): LlmClient {
  return {
    async parse<T>(params: LlmParseParams<T>): Promise<LlmParsed<T>> {
      const res = await sdk.messages.parse(params);
      return {
        parsed_output: res.parsed_output as T | null,
        stop_reason: res.stop_reason,
        stop_details: res.stop_details,
        usage: res.usage,
        model: res.model,
        content: res.content,
      };
    },
    toolRunner(params: LlmToolRunnerParams): LlmToolRunner {
      return new SdkToolRunner(sdk.beta.messages.toolRunner({ ...params, stream: false }) as BetaToolRunner<false>);
    },
    async countTokens(params: MessageCountTokensParams): Promise<number> {
      const res = await sdk.messages.countTokens(params);
      return res.input_tokens;
    },
  };
}
