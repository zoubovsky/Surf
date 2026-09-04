import { retry, sleep as defaultSleep } from "@surf/core";
import type { FetchLike } from "./types.js";

export const USER_AGENT = "surf-market-data/0.1";

/** Non-2xx response (or unparseable body) from a market data endpoint. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
    detail?: string,
  ) {
    super(`HTTP ${status} from ${url}${detail ? `: ${detail}` : ""}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
}

/** Options shared by every fetcher in this package. */
export interface RequestOptions {
  fetch: FetchLike;
  /** Override the venue base URL (tests, testnets). */
  baseUrl?: string;
  /** Abort a single attempt after this long. Default 15s. */
  timeoutMs?: number;
  /** Total attempts for retryable failures (network, 429, 5xx). Default 3. */
  attempts?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

export type QueryParams = Record<string, string | number | undefined>;

export function buildUrl(base: string, path: string, params: QueryParams = {}): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // Network-level failures (TypeError from fetch, AbortError) are worth another try.
  return true;
}

async function getOnce(url: string, opts: RequestOptions): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await opts.fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...opts.headers },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(url, res.status, text);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(url, res.status, text, "invalid JSON body");
    }
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** GET a JSON document with bounded retries. 4xx (except 429) fail immediately. */
export async function getJson(url: string, opts: RequestOptions): Promise<unknown> {
  const outcome = await retry<Outcome>(
    async () => {
      try {
        return { ok: true, value: await getOnce(url, opts) };
      } catch (error) {
        if (isRetryable(error)) throw error;
        return { ok: false, error };
      }
    },
    { attempts: opts.attempts ?? 3, baseMs: 400, maxMs: 4000 },
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Simple request pacer: guarantees at least `minIntervalMs` between successive `wait()` returns. */
export class Pacer {
  private nextAllowed = 0;
  constructor(
    private readonly minIntervalMs: number,
    private readonly deps: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: Date.now,
      sleep: defaultSleep,
    },
  ) {}

  static perSecond(rps: number, deps?: { now: () => number; sleep: (ms: number) => Promise<void> }): Pacer {
    return new Pacer(Math.ceil(1000 / rps), deps);
  }

  async wait(): Promise<void> {
    const now = this.deps.now();
    const next = Math.max(now, this.nextAllowed);
    if (next > now) await this.deps.sleep(next - now);
    this.nextAllowed = next + this.minIntervalMs;
  }
}
