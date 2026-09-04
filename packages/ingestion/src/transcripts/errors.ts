export interface TranscriptErrorOptions {
  provider: string;
  /** Whether the same request may succeed later without operator action. */
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

/** Base class for provider-level failures (as opposed to "this video has no transcript", which is `null`). */
export class TranscriptError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(message: string, opts: TranscriptErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TranscriptError";
    this.provider = opts.provider;
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/** YouTube bot check / IP block / consent wall. Expected from datacenter IPs. */
export class TranscriptBlockedError extends TranscriptError {
  readonly reason: string;
  constructor(provider: string, reason: string, opts: { status?: number; cause?: unknown } = {}) {
    super(`${provider}: blocked by YouTube (${reason})`, { provider, retryable: true, ...opts });
    this.name = "TranscriptBlockedError";
    this.reason = reason;
  }
}

/** Missing/invalid API key, plan limit, or payment required. Needs operator action; never retried. */
export class TranscriptAuthError extends TranscriptError {
  constructor(provider: string, message: string, status?: number) {
    super(`${provider}: ${message}`, {
      provider,
      retryable: false,
      ...(status !== undefined ? { status } : {}),
    });
    this.name = "TranscriptAuthError";
  }
}

/** HTTP 429 or equivalent. */
export class TranscriptRateLimitError extends TranscriptError {
  readonly retryAfterMs: number | undefined;
  constructor(provider: string, retryAfterMs?: number, status = 429) {
    super(`${provider}: rate limited`, { provider, retryable: true, status });
    this.name = "TranscriptRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTranscriptError(err: unknown): err is TranscriptError {
  return err instanceof TranscriptError;
}
