import { createLogger, sleep as defaultSleep, systemClock, type Clock, type Logger } from "@surf/core";
import { TranscriptBlockedError, TranscriptError, TranscriptRateLimitError } from "./errors.js";
import type { Transcript, TranscriptProvider } from "./types.js";

export type AttemptOutcome =
  /** Transcript returned. */
  | "ok"
  /** Provider ran fine but has no transcript for this video (yet). */
  | "none"
  /** Bot check / IP block. */
  | "blocked"
  /** HTTP 429. */
  | "rate-limited"
  /** Auth/plan problem or other non-retryable failure; needs operator action. */
  | "fatal"
  /** Transient failure (network, 5xx, unexpected body). */
  | "error";

export interface ProviderAttempt {
  provider: string;
  outcome: AttemptOutcome;
  at: number;
  durationMs: number;
  error?: string;
  retryAfterMs?: number;
}

export interface ChainFetchResult {
  transcript: Transcript | null;
  attempts: ProviderAttempt[];
  /** No provider produced a "none": every provider that ran was blocked or fatal, so waiting alone will not help. */
  blocked: boolean;
}

export interface ChainOptions {
  /** Wait before the first attempt. Captions rarely exist right after publication. Default 10 min. */
  initialDelayMs?: number;
  /** Delays between consecutive failed rounds; the last value repeats. Default 20m, 40m, 80m, 160m. */
  retrySchedule?: number[];
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface FetchWithRetryOptions {
  /** Total time budget measured from the call. Default 6h. */
  deadlineMs?: number;
  lang?: string;
  /** Skip the initial delay (e.g. the daemon already waited, or the video is old). */
  immediate?: boolean;
  signal?: AbortSignal;
}

export interface FetchWithRetryResult {
  /** `ok`: transcript; `pending`: nothing yet, retry after `nextRetryMs`; `blocked`: every provider blocked/fatal. */
  status: "ok" | "pending" | "blocked";
  transcript?: Transcript;
  attempts: ProviderAttempt[];
  rounds: number;
  /** Suggested delay before the daemon reschedules, when `pending`. */
  nextRetryMs?: number;
}

const MIN = 60_000;
export const DEFAULT_INITIAL_DELAY_MS = 10 * MIN;
export const DEFAULT_RETRY_SCHEDULE = [20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN];
export const DEFAULT_DEADLINE_MS = 6 * 60 * MIN;

/**
 * Tries providers in order until one returns a transcript. Providers that throw are recorded and skipped;
 * the first `ok` wins. `fetchWithRetry` adds the T+10min / backoff-to-6h schedule for the daemon's job runner.
 */
export class TranscriptChain {
  readonly providers: readonly TranscriptProvider[];
  private readonly initialDelayMs: number;
  private readonly schedule: readonly number[];
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(providers: readonly TranscriptProvider[], opts: ChainOptions = {}) {
    if (providers.length === 0) throw new Error("TranscriptChain needs at least one provider");
    this.providers = providers;
    this.initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.schedule =
      opts.retrySchedule && opts.retrySchedule.length > 0 ? opts.retrySchedule : DEFAULT_RETRY_SCHEDULE;
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? createLogger("silent", "ingestion");
  }

  /** Delay to wait after `round` consecutive failed rounds (round 0 = after the first failure). */
  retryDelay(round: number): number {
    return this.schedule[Math.min(round, this.schedule.length - 1)] ?? 0;
  }

  /** One pass over all providers. Never throws for provider errors; they are recorded in `attempts`. */
  async fetch(videoId: string, lang = "en"): Promise<ChainFetchResult> {
    const attempts: ProviderAttempt[] = [];
    for (const p of this.providers) {
      const at = this.clock.now();
      const started = performance.now();
      try {
        const transcript = await p.fetch(videoId, lang);
        const durationMs = Math.round(performance.now() - started);
        if (transcript && transcript.segments.length > 0) {
          attempts.push({ provider: p.name, outcome: "ok", at, durationMs });
          this.logger.info(
            { videoId, provider: p.name, segments: transcript.segments.length },
            "transcript fetched",
          );
          return { transcript, attempts, blocked: false };
        }
        attempts.push({ provider: p.name, outcome: "none", at, durationMs });
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        const attempt: ProviderAttempt = {
          provider: p.name,
          outcome: classify(err),
          at,
          durationMs,
          error: String((err as Error)?.message ?? err).slice(0, 500),
        };
        if (err instanceof TranscriptRateLimitError && err.retryAfterMs !== undefined)
          attempt.retryAfterMs = err.retryAfterMs;
        attempts.push(attempt);
        this.logger.warn(
          { videoId, provider: p.name, outcome: attempt.outcome, err: attempt.error },
          "transcript provider failed",
        );
      }
    }
    const blocked =
      attempts.length > 0 && attempts.every((a) => a.outcome === "blocked" || a.outcome === "fatal");
    return { transcript: null, attempts, blocked };
  }

  /**
   * Run the chain on the retry schedule until a transcript arrives, every provider is blocked, or the
   * deadline would be exceeded by the next wait. Uses the injected `sleep`, so tests can run it instantly.
   */
  async fetchWithRetry(videoId: string, opts: FetchWithRetryOptions = {}): Promise<FetchWithRetryResult> {
    const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const lang = opts.lang ?? "en";
    const start = this.clock.now();
    const attempts: ProviderAttempt[] = [];
    let rounds = 0;
    let delay = opts.immediate ? 0 : this.initialDelayMs;

    for (;;) {
      if (opts.signal?.aborted) return { status: "pending", attempts, rounds, nextRetryMs: delay };
      if (delay > 0) {
        if (this.clock.now() - start + delay > deadlineMs)
          return { status: "pending", attempts, rounds, nextRetryMs: delay };
        await this.sleep(delay);
      }
      const r = await this.fetch(videoId, lang);
      rounds++;
      attempts.push(...r.attempts);
      if (r.transcript) return { status: "ok", transcript: r.transcript, attempts, rounds };
      if (r.blocked) return { status: "blocked", attempts, rounds };
      delay = this.retryDelay(rounds - 1);
      const retryAfter = Math.max(0, ...r.attempts.map((a) => a.retryAfterMs ?? 0));
      if (retryAfter > delay) delay = retryAfter;
    }
  }
}

export function classify(err: unknown): AttemptOutcome {
  if (err instanceof TranscriptBlockedError) return "blocked";
  if (err instanceof TranscriptRateLimitError) return "rate-limited";
  if (err instanceof TranscriptError) return err.retryable ? "error" : "fatal";
  return "error";
}
