/** Typed failures raised by LLM stages. Callers map these to terminal states; none is ever "success". */
export class LlmStageError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`[${stage}] ${message}`);
    this.name = new.target.name;
  }
}

/** The model refused (stop_reason "refusal"). Carries the structured stop details when present. */
export class LlmRefusalError extends LlmStageError {
  constructor(
    stage: string,
    public readonly category: string | null,
    public readonly explanation: string | null,
  ) {
    super(stage, `model refused${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
  }
}

/** Output was cut off by max_tokens; the structured output is unusable. */
export class LlmTruncatedError extends LlmStageError {
  constructor(stage: string) {
    super(stage, "response truncated by max_tokens");
  }
}

/** The response did not yield a schema-valid structured output. */
export class LlmOutputError extends LlmStageError {
  constructor(stage: string, detail: string) {
    super(stage, `unusable output: ${detail}`);
  }
}

/** Deterministic evidence verification left nothing to stand on. */
export class UnsupportedPriorError extends LlmStageError {
  constructor(
    public readonly videoId: string,
    detail: string,
  ) {
    super("extract-prior", `no verifiable evidence for video ${videoId}: ${detail}`);
  }
}
