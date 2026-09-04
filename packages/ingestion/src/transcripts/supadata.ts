import { sleep as defaultSleep, systemClock, type Clock } from "@surf/core";
import { z } from "zod";
import type { FetchLike } from "../feed.js";
import { TranscriptAuthError, TranscriptError, TranscriptRateLimitError } from "./errors.js";
import {
  assertVideoId,
  buildTranscript,
  type Transcript,
  type TranscriptProvider,
  type TranscriptSegment,
} from "./types.js";

/**
 * Supadata YouTube transcript client. Verified against https://docs.supadata.ai (llms-full.txt, Sep 2026):
 *
 *   GET https://api.supadata.ai/v1/youtube/transcript?videoId=<id>&lang=en&text=false
 *   header: x-api-key
 *   200 -> { content: [{ text, offset(ms), duration(ms), lang }], lang, availableLangs[] }   (text=false)
 *   200 -> { content: string, lang, availableLangs[] }                                         (text=true)
 *   202 -> { jobId }   poll GET /v1/transcript/{jobId} -> { status: queued|active|completed|failed, content?, lang?, error? }
 *   206 -> { error: "transcript-unavailable", ... }   (still costs 1 credit)
 *   400 invalid-request, 401 unauthorized, 402 upgrade-required, 403 forbidden (restricted video),
 *   404 not-found, 429 limit-exceeded, 5xx internal-error; body { error, message, details, documentationUrl }
 *
 * Credits: 1 per native transcript; the `x-billable-requests` response header carries the charge.
 * Free plan: 100 credits/month at 1 request/second. Job results expire after 1 hour.
 * The YouTube endpoint only returns existing (native) transcripts; the universal `/v1/transcript`
 * endpoint adds `mode=native|auto|generate` (AI generation costs 2 credits per media minute).
 */

export const SUPADATA_BASE_URL = "https://api.supadata.ai/v1";
export const SUPADATA_API_KEY_ENV = "SUPADATA_API_KEY";

export interface SupadataOptions {
  apiKey: string;
  fetch?: FetchLike;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** `youtube` (default, native captions only) or `universal` (`/transcript`, supports `mode`). */
  endpoint?: "youtube" | "universal";
  /** Only used with the universal endpoint. Default `native` so AI generation is never triggered by accident. */
  mode?: "native" | "auto" | "generate";
  /** Interval between job-status polls after a 202. Docs recommend 1s. */
  pollIntervalMs?: number;
  /** Give up waiting for a job after this long (the job itself keeps running server-side). */
  maxPollMs?: number;
}

const Chunk = z.object({
  text: z.string(),
  offset: z.number(),
  duration: z.number().optional(),
  lang: z.string().optional(),
});
const TranscriptBody = z.object({
  content: z.union([z.array(Chunk), z.string()]),
  lang: z.string().optional(),
  availableLangs: z.array(z.string()).optional(),
});
const JobAccepted = z.object({ jobId: z.string().min(1) });
const JobStatus = z.object({
  status: z.enum(["queued", "active", "completed", "failed"]),
  content: z.union([z.array(Chunk), z.string()]).optional(),
  lang: z.string().optional(),
  availableLangs: z.array(z.string()).optional(),
  error: z.unknown().optional(),
});
const ErrorBody = z
  .object({ error: z.string().optional(), message: z.string().optional(), details: z.string().optional() })
  .passthrough();

type TranscriptBody = z.infer<typeof TranscriptBody>;

export class SupadataProvider implements TranscriptProvider {
  readonly name = "supadata";
  /** Running counters for budget visibility (100 free credits/month). */
  readonly stats = { requests: 0, credits: 0 };
  private readonly http: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly endpoint: "youtube" | "universal";
  private readonly mode: "native" | "auto" | "generate";
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;

  constructor(private readonly opts: SupadataOptions) {
    if (!opts.apiKey) throw new TranscriptAuthError("supadata", `missing API key (${SUPADATA_API_KEY_ENV})`);
    this.http = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? defaultSleep;
    this.baseUrl = (opts.baseUrl ?? SUPADATA_BASE_URL).replace(/\/+$/, "");
    this.endpoint = opts.endpoint ?? "youtube";
    this.mode = opts.mode ?? "native";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxPollMs = opts.maxPollMs ?? 120_000;
  }

  async fetch(videoId: string, lang = "en"): Promise<Transcript | null> {
    assertVideoId(videoId);
    const url = new URL(
      this.endpoint === "youtube" ? `${this.baseUrl}/youtube/transcript` : `${this.baseUrl}/transcript`,
    );
    if (this.endpoint === "youtube") url.searchParams.set("videoId", videoId);
    else {
      url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
      url.searchParams.set("mode", this.mode);
    }
    url.searchParams.set("lang", lang);
    url.searchParams.set("text", "false");

    const res = await this.request(url.toString());
    if (res.status === 202) {
      const accepted = JobAccepted.safeParse(await readJson(res));
      if (!accepted.success)
        throw new TranscriptError("supadata: 202 without jobId", {
          provider: this.name,
          retryable: true,
          status: 202,
        });
      return this.pollJob(accepted.data.jobId, videoId);
    }
    if (res.status === 206) return null; // transcript-unavailable (charged 1 credit)
    if (res.status === 404) return null; // video does not exist or is private
    if (res.status !== 200) throw await this.toError(res);

    const body = TranscriptBody.safeParse(await readJson(res));
    if (!body.success)
      throw new TranscriptError("supadata: unexpected 200 body", {
        provider: this.name,
        retryable: true,
        status: 200,
      });
    return this.toTranscript(videoId, lang, body.data);
  }

  private async pollJob(jobId: string, videoId: string): Promise<Transcript | null> {
    const started = this.clock.now();
    for (;;) {
      await this.sleep(this.pollIntervalMs);
      const res = await this.request(`${this.baseUrl}/transcript/${encodeURIComponent(jobId)}`);
      if (res.status !== 200) throw await this.toError(res);
      const job = JobStatus.safeParse(await readJson(res));
      if (!job.success)
        throw new TranscriptError("supadata: unexpected job status body", {
          provider: this.name,
          retryable: true,
          status: 200,
        });
      if (job.data.status === "completed") {
        if (job.data.content === undefined) return null;
        return this.toTranscript(videoId, job.data.lang ?? "en", {
          content: job.data.content,
          ...(job.data.lang ? { lang: job.data.lang } : {}),
        });
      }
      if (job.data.status === "failed") {
        throw new TranscriptError(
          `supadata: job failed: ${JSON.stringify(job.data.error ?? null).slice(0, 200)}`,
          {
            provider: this.name,
            retryable: true,
          },
        );
      }
      if (this.clock.now() - started > this.maxPollMs) {
        throw new TranscriptError(
          `supadata: job ${jobId} still ${job.data.status} after ${this.maxPollMs}ms`,
          {
            provider: this.name,
            retryable: true,
          },
        );
      }
    }
  }

  private async request(url: string): Promise<Response> {
    this.stats.requests++;
    let res: Response;
    try {
      res = await this.http(url, {
        method: "GET",
        headers: { "x-api-key": this.opts.apiKey, accept: "application/json" },
      });
    } catch (err) {
      throw new TranscriptError(`supadata: network error: ${(err as Error).message}`, {
        provider: this.name,
        retryable: true,
        cause: err,
      });
    }
    const billable = Number(res.headers.get("x-billable-requests"));
    if (Number.isFinite(billable) && billable > 0) this.stats.credits += billable;
    return res;
  }

  private async toError(res: Response): Promise<TranscriptError> {
    const body = ErrorBody.safeParse(await readJson(res).catch(() => null));
    const code = body.success ? (body.data.error ?? "") : "";
    const msg = body.success ? (body.data.message ?? body.data.details ?? "") : "";
    const detail = `${code || `HTTP ${res.status}`}${msg ? `: ${msg}` : ""}`;
    switch (res.status) {
      case 401:
      case 402:
        return new TranscriptAuthError(this.name, detail, res.status);
      case 429: {
        const ra = res.headers.get("retry-after");
        const sec = ra ? Number(ra) : NaN;
        return new TranscriptRateLimitError(this.name, Number.isFinite(sec) ? sec * 1000 : undefined);
      }
      default:
        return new TranscriptError(`supadata: ${detail}`, {
          provider: this.name,
          retryable: res.status >= 500,
          status: res.status,
        });
    }
  }

  private toTranscript(videoId: string, requestedLang: string, body: TranscriptBody): Transcript | null {
    const language = body.lang ?? requestedLang;
    let segments: TranscriptSegment[];
    if (typeof body.content === "string") {
      if (!body.content.trim()) return null;
      segments = [{ start: 0, duration: 0, text: body.content }];
    } else {
      if (body.content.length === 0) return null; // success but no speech detected
      segments = body.content.map((c) => ({
        start: c.offset / 1000,
        duration: (c.duration ?? 0) / 1000,
        text: c.text,
      }));
    }
    return buildTranscript({ videoId, language, source: this.name, segments, fetchedAt: this.clock.now() });
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Build a provider from the environment; returns null when `SUPADATA_API_KEY` is unset. */
export function supadataFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<SupadataOptions, "apiKey"> = {},
): SupadataProvider | null {
  const apiKey = env[SUPADATA_API_KEY_ENV];
  return apiKey ? new SupadataProvider({ ...opts, apiKey }) : null;
}
