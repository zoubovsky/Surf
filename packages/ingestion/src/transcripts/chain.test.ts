import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_SCHEDULE, TranscriptChain } from "./chain.js";
import {
  TranscriptAuthError,
  TranscriptBlockedError,
  TranscriptError,
  TranscriptRateLimitError,
} from "./errors.js";
import { buildTranscript, type Transcript, type TranscriptProvider } from "./types.js";

const MIN = 60_000;
const T: Transcript = buildTranscript({
  videoId: "3wXfppSKkpg",
  language: "en",
  source: "stub",
  segments: [{ start: 0, duration: 1, text: "hi" }],
  fetchedAt: 0,
});

type Behaviour = Transcript | null | Error;
function stub(name: string, ...behaviours: Behaviour[]): TranscriptProvider & { calls: number } {
  let i = 0;
  const p = {
    name,
    calls: 0,
    async fetch(): Promise<Transcript | null> {
      p.calls++;
      const b = behaviours[Math.min(i++, behaviours.length - 1)];
      if (b instanceof Error) throw b;
      return b ?? null;
    },
  };
  return p;
}

/** Fake time: sleep() advances the clock instantly and records the delay. */
function fakeTime(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    clock: { now: () => t },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    now: () => t,
  };
}

describe("TranscriptChain.fetch", () => {
  it("tries providers in order and stops at the first transcript", async () => {
    const a = stub("a", null);
    const b = stub("b", T);
    const c = stub("c", T);
    const chain = new TranscriptChain([a, b, c]);
    const r = await chain.fetch("3wXfppSKkpg");
    expect(r.transcript).toBe(T);
    expect(r.attempts.map((x) => [x.provider, x.outcome])).toEqual([
      ["a", "none"],
      ["b", "ok"],
    ]);
    expect(c.calls).toBe(0);
    expect(r.blocked).toBe(false);
  });

  it("records thrown errors by class and continues", async () => {
    const chain = new TranscriptChain([
      stub("supadata", new TranscriptRateLimitError("supadata", 5000)),
      stub("innertube", new TranscriptBlockedError("innertube", "recaptcha")),
      stub("yt-dlp", new TranscriptError("x", { provider: "yt-dlp", retryable: true })),
      stub("other", new Error("plain")),
    ]);
    const r = await chain.fetch("3wXfppSKkpg");
    expect(r.transcript).toBeNull();
    expect(r.attempts.map((x) => x.outcome)).toEqual(["rate-limited", "blocked", "error", "error"]);
    expect(r.attempts[0]!.retryAfterMs).toBe(5000);
    expect(r.attempts[1]!.error).toMatch(/blocked by YouTube \(recaptcha\)/);
    expect(r.blocked).toBe(false);
  });

  it("is blocked only when every provider was blocked or fatal", async () => {
    const chain = new TranscriptChain([
      stub("supadata", new TranscriptAuthError("supadata", "unauthorized", 401)),
      stub("innertube", new TranscriptBlockedError("innertube", "http-429")),
    ]);
    const r = await chain.fetch("3wXfppSKkpg");
    expect(r.attempts.map((x) => x.outcome)).toEqual(["fatal", "blocked"]);
    expect(r.blocked).toBe(true);

    const mixed = new TranscriptChain([
      stub("innertube", new TranscriptBlockedError("innertube", "http-429")),
      stub("yt-dlp", null),
    ]);
    expect((await mixed.fetch("3wXfppSKkpg")).blocked).toBe(false);
  });

  it("treats an empty transcript as none", async () => {
    const empty = { ...T, segments: [] };
    const r = await new TranscriptChain([stub("a", empty)]).fetch("3wXfppSKkpg");
    expect(r.transcript).toBeNull();
    expect(r.attempts[0]!.outcome).toBe("none");
  });

  it("requires at least one provider", () => {
    expect(() => new TranscriptChain([])).toThrow();
  });
});

describe("TranscriptChain.fetchWithRetry", () => {
  it("default schedule: first try at T+10min, then 20/40/80/160 min backoff", () => {
    const chain = new TranscriptChain([stub("a", null)]);
    expect(DEFAULT_RETRY_SCHEDULE).toEqual([20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN]);
    expect([0, 1, 2, 3, 4, 9].map((r) => chain.retryDelay(r))).toEqual([
      20 * MIN,
      40 * MIN,
      80 * MIN,
      160 * MIN,
      160 * MIN,
      160 * MIN,
    ]);
  });

  it("waits the initial delay, retries on the schedule and returns ok", async () => {
    const time = fakeTime();
    const a = stub("a", null, null, T);
    const chain = new TranscriptChain([a], { clock: time.clock, sleep: time.sleep });
    const r = await chain.fetchWithRetry("3wXfppSKkpg");
    expect(r.status).toBe("ok");
    expect(r.transcript).toBe(T);
    expect(r.rounds).toBe(3);
    expect(time.sleeps).toEqual([10 * MIN, 20 * MIN, 40 * MIN]);
    expect(r.attempts.map((x) => x.outcome)).toEqual(["none", "none", "ok"]);
  });

  it("returns pending with a hint once the next wait would cross the 6h deadline", async () => {
    const time = fakeTime();
    const a = stub("a", null);
    const chain = new TranscriptChain([a], { clock: time.clock, sleep: time.sleep });
    const r = await chain.fetchWithRetry("3wXfppSKkpg");
    expect(r.status).toBe("pending");
    // attempts at 10, 30, 70, 150, 310 min; the next (+160 = 470) exceeds 360.
    expect(time.sleeps).toEqual([10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN]);
    expect(r.rounds).toBe(5);
    expect(a.calls).toBe(5);
    expect(r.nextRetryMs).toBe(160 * MIN);
    expect(time.now() - 1_000_000).toBe(310 * MIN);
  });

  it("stops immediately with blocked when every provider is blocked/fatal", async () => {
    const time = fakeTime();
    const chain = new TranscriptChain(
      [
        stub("supadata", new TranscriptAuthError("supadata", "unauthorized", 401)),
        stub("innertube", new TranscriptBlockedError("innertube", "recaptcha")),
      ],
      { clock: time.clock, sleep: time.sleep },
    );
    const r = await chain.fetchWithRetry("3wXfppSKkpg", { immediate: true });
    expect(r.status).toBe("blocked");
    expect(r.rounds).toBe(1);
    expect(time.sleeps).toEqual([]);
    expect(r.attempts.map((x) => x.outcome)).toEqual(["fatal", "blocked"]);
  });

  it("a blocked direct path plus a working Supadata still succeeds", async () => {
    const time = fakeTime();
    const chain = new TranscriptChain(
      [stub("supadata", null, T), stub("innertube", new TranscriptBlockedError("innertube", "recaptcha"))],
      {
        clock: time.clock,
        sleep: time.sleep,
      },
    );
    const r = await chain.fetchWithRetry("3wXfppSKkpg", { immediate: true });
    expect(r.status).toBe("ok");
    expect(r.rounds).toBe(2);
    expect(time.sleeps).toEqual([20 * MIN]);
  });

  it("honours Retry-After when larger than the scheduled delay and custom schedules", async () => {
    const time = fakeTime();
    const chain = new TranscriptChain(
      [stub("supadata", new TranscriptRateLimitError("supadata", 3 * MIN), T)],
      {
        clock: time.clock,
        sleep: time.sleep,
        initialDelayMs: 0,
        retrySchedule: [1 * MIN],
      },
    );
    const r = await chain.fetchWithRetry("3wXfppSKkpg");
    expect(r.status).toBe("ok");
    expect(time.sleeps).toEqual([3 * MIN]);
  });

  it("respects a short deadline and an abort signal", async () => {
    const time = fakeTime();
    const chain = new TranscriptChain([stub("a", null)], { clock: time.clock, sleep: time.sleep });
    const r = await chain.fetchWithRetry("3wXfppSKkpg", { deadlineMs: 5 * MIN });
    expect(r.status).toBe("pending");
    expect(r.rounds).toBe(0);
    expect(r.nextRetryMs).toBe(10 * MIN);

    const ac = new AbortController();
    ac.abort();
    const r2 = await chain.fetchWithRetry("3wXfppSKkpg", { signal: ac.signal, immediate: true });
    expect(r2.status).toBe("pending");
    expect(r2.rounds).toBe(0);
  });
});
