import { describe, expect, it } from "vitest";
import type { FetchLike } from "../feed.js";
import { TranscriptAuthError, TranscriptError, TranscriptRateLimitError } from "./errors.js";
import { SupadataProvider, supadataFromEnv } from "./supadata.js";

type Step = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error("unexpected extra request " + url);
    const body = step.body === undefined ? null : typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    return new Response(body, { status: step.status, headers: step.headers ?? {} });
  };
  return { fetch, calls };
}

const clock = { now: () => 1_757_000_000_000 };
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const mk = (steps: Step[], extra: Partial<ConstructorParameters<typeof SupadataProvider>[0]> = {}) => {
  const f = fakeFetch(steps);
  return { ...f, provider: new SupadataProvider({ apiKey: "k", fetch: f.fetch, clock, sleep, ...extra }) };
};

const SEGMENTS = [
  { text: "hello and welcome", offset: 480, duration: 4560, lang: "en" },
  { text: "the key level is 79k", offset: 5040, duration: 5280, lang: "en" },
];

describe("SupadataProvider", () => {
  it("calls the documented YouTube endpoint with the x-api-key header", async () => {
    const { provider, calls } = mk([{ status: 200, body: { content: SEGMENTS, lang: "en", availableLangs: ["en"] }, headers: { "x-billable-requests": "1" } }]);
    const t = await provider.fetch("3wXfppSKkpg");
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.supadata.ai/v1/youtube/transcript");
    expect(Object.fromEntries(u.searchParams)).toEqual({ videoId: "3wXfppSKkpg", lang: "en", text: "false" });
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(t).toMatchObject({ videoId: "3wXfppSKkpg", language: "en", source: "supadata", fetchedAt: clock.now() });
    expect(t!.segments).toEqual([
      { start: 0.48, duration: 4.56, text: "hello and welcome" },
      { start: 5.04, duration: 5.28, text: "the key level is 79k" },
    ]);
    expect(t!.text).toBe("hello and welcome the key level is 79k");
    expect(provider.stats).toEqual({ requests: 1, credits: 1 });
  });

  it("accepts plain-text content and reports the returned language", async () => {
    const { provider } = mk([{ status: 200, body: { content: "just text", lang: "de", availableLangs: ["de"] } }]);
    const t = await provider.fetch("3wXfppSKkpg", "en");
    expect(t!.language).toBe("de");
    expect(t!.segments).toEqual([{ start: 0, duration: 0, text: "just text" }]);
  });

  it("returns null on 206 transcript-unavailable, 404 and empty content", async () => {
    const { provider } = mk([
      { status: 206, body: { error: "transcript-unavailable", message: "Transcript Unavailable" } },
      { status: 404, body: { error: "not-found" } },
      { status: 200, body: { content: [], lang: "en" } },
    ]);
    expect(await provider.fetch("3wXfppSKkpg")).toBeNull();
    expect(await provider.fetch("3wXfppSKkpg")).toBeNull();
    expect(await provider.fetch("3wXfppSKkpg")).toBeNull();
  });

  it("maps 401/402 to TranscriptAuthError (not retryable)", async () => {
    const { provider } = mk([
      { status: 401, body: { error: "unauthorized", message: "Please check your API key" } },
      { status: 402, body: { error: "upgrade-required" } },
    ]);
    const e1 = await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TranscriptAuthError);
    expect((e1 as TranscriptError).retryable).toBe(false);
    expect((e1 as TranscriptError).message).toMatch(/unauthorized: Please check your API key/);
    const e2 = await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(TranscriptAuthError);
    expect((e2 as TranscriptError).status).toBe(402);
  });

  it("maps 429 to TranscriptRateLimitError with Retry-After", async () => {
    const { provider } = mk([{ status: 429, body: { error: "limit-exceeded" }, headers: { "retry-after": "2" } }]);
    const e = await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(TranscriptRateLimitError);
    expect((e as TranscriptRateLimitError).retryAfterMs).toBe(2000);
    expect((e as TranscriptError).retryable).toBe(true);
  });

  it("5xx is retryable, 400/403 are not", async () => {
    const { provider } = mk([{ status: 500, body: { error: "internal-error" } }, { status: 403, body: { error: "forbidden" } }, { status: 400, body: "not json" }]);
    const e1 = (await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e1.retryable).toBe(true);
    const e2 = (await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e2.retryable).toBe(false);
    expect(e2.status).toBe(403);
    const e3 = (await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e3.message).toMatch(/HTTP 400/);
  });

  it("handles 202 processing by polling the job endpoint", async () => {
    sleeps.length = 0;
    const { provider, calls } = mk(
      [
        { status: 202, body: { jobId: "123e4567-e89b-12d3-a456-426614174000" } },
        { status: 200, body: { status: "queued" } },
        { status: 200, body: { status: "active" } },
        { status: 200, body: { status: "completed", content: SEGMENTS, lang: "en", availableLangs: ["en"] } },
      ],
      { pollIntervalMs: 1000 },
    );
    const t = await provider.fetch("3wXfppSKkpg");
    expect(t!.segments).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.supadata.ai/v1/transcript/123e4567-e89b-12d3-a456-426614174000");
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("a failed job is a retryable error; a stalled job times out", async () => {
    const { provider } = mk([{ status: 202, body: { jobId: "j1" } }, { status: 200, body: { status: "failed", error: { message: "boom" } } }]);
    const e = (await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e).toBeInstanceOf(TranscriptError);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/job failed/);

    let t = 0;
    const ticking = { now: () => (t += 60_000) };
    const f = fakeFetch([{ status: 202, body: { jobId: "j2" } }, { status: 200, body: { status: "active" } }, { status: 200, body: { status: "active" } }]);
    const p2 = new SupadataProvider({ apiKey: "k", fetch: f.fetch, clock: ticking, sleep, maxPollMs: 90_000 });
    const e2 = (await p2.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e2.message).toMatch(/still active/);
    expect(e2.retryable).toBe(true);
  });

  it("network failures surface as retryable TranscriptError", async () => {
    const provider = new SupadataProvider({
      apiKey: "k",
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const e = (await provider.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/ECONNRESET/);
  });

  it("universal endpoint variant sends url + mode", async () => {
    const { provider, calls } = mk([{ status: 200, body: { content: SEGMENTS, lang: "en" } }], { endpoint: "universal", mode: "native" });
    await provider.fetch("3wXfppSKkpg");
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/transcript");
    expect(u.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=3wXfppSKkpg");
    expect(u.searchParams.get("mode")).toBe("native");
  });

  it("rejects bad video ids and missing keys", async () => {
    const { provider } = mk([]);
    await expect(provider.fetch("../etc/passwd")).rejects.toThrow(TypeError);
    expect(() => new SupadataProvider({ apiKey: "" })).toThrow(TranscriptAuthError);
    expect(supadataFromEnv({})).toBeNull();
    expect(supadataFromEnv({ SUPADATA_API_KEY: "abc" })).toBeInstanceOf(SupadataProvider);
  });
});
