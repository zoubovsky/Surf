import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Clock } from "@surf/core";
import type { FeedVideo, FetchLike } from "./feed.js";
import { FeedWatcher, InMemorySeenStore } from "./watcher.js";

const FIXTURE = readFileSync(new URL("./__fixtures__/uulf-feed.xml", import.meta.url), "utf8");
const NEWEST = Date.parse("2026-09-04T16:48:41+00:00"); // JUq2FuOWuX8
const HOUR = 3_600_000;

class FakeClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
}

function entry(id: string, title: string, publishedIso: string): string {
  return `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><yt:channelId>UCngIhBkikUe6e7tZTjpKK7Q</yt:channelId><title>${title}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><published>${publishedIso}</published><updated>${publishedIso}</updated></entry>`;
}

function withNewEntry(xml: string, e: string): string {
  return xml.replace("<entry>", `${e}<entry>`);
}

function feedServer(initial: string) {
  let body = initial;
  let status = 200;
  let failures = 0;
  const calls: RequestInit[] = [];
  const fetch: FetchLike = async (_url, init) => {
    calls.push(init ?? {});
    if (failures > 0) {
      failures--;
      return new Response("boom", { status: 502 });
    }
    return new Response(status === 304 ? null : body, { status, headers: { etag: `"v${calls.length}"` } });
  };
  return {
    fetch,
    calls,
    set(b: string) {
      body = b;
      status = 200;
    },
    notModified() {
      status = 304;
    },
    failNext(n: number) {
      failures = n;
    },
  };
}

describe("FeedWatcher", () => {
  it("emits only Bitcoin videos inside the lookback window, oldest first, once", async () => {
    const clock = new FakeClock(NEWEST + HOUR);
    const server = feedServer(FIXTURE);
    const seen = new InMemorySeenStore();
    const watcher = new FeedWatcher({ fetch: server.fetch, seen, clock, lookbackMs: 24 * HOUR });
    const events: FeedVideo[] = [];
    watcher.on("video", (v) => events.push(v));

    const r1 = await watcher.poll();
    // Window: NEWEST + 1h - 24h = 2026-09-03T17:48:41Z. Six videos are newer; only one is Bitcoin.
    expect(r1.feedCount).toBe(15);
    expect(r1.videos.map((v) => v.videoId)).toEqual(["3wXfppSKkpg"]);
    expect(r1.skipped).toEqual({ tooOld: 9, seen: 0, filtered: 5 });
    expect(events.map((v) => v.videoId)).toEqual(["3wXfppSKkpg"]);
    // Every evaluated video is recorded, with the filter verdict, so a restart never re-evaluates it.
    expect(seen.size).toBe(6);
    expect(seen.get("3wXfppSKkpg")?.matched).toBe(true);
    expect(seen.get("JUq2FuOWuX8")?.matched).toBe(false);

    const r2 = await watcher.poll();
    expect(r2.videos).toEqual([]);
    expect(r2.skipped).toEqual({ tooOld: 9, seen: 6, filtered: 0 });
    expect(events).toHaveLength(1);
  });

  it("a wider lookback pulls in older Bitcoin videos in publication order", async () => {
    const clock = new FakeClock(NEWEST + HOUR);
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({ fetch: server.fetch, seen: new InMemorySeenStore(), clock, lookbackMs: 72 * HOUR });
    const r = await watcher.poll();
    expect(r.videos.map((v) => v.videoId)).toEqual(["qzQ2pUZlmGg", "rsLjW9aDPeg", "bBNu9b3HyWw", "3wXfppSKkpg"]);
    for (let i = 1; i < r.videos.length; i++) expect(r.videos[i]!.publishedAt).toBeGreaterThan(r.videos[i - 1]!.publishedAt);
  });

  it("does not re-ingest history after a restart with a persistent store", async () => {
    const seen = new InMemorySeenStore();
    const server = feedServer(FIXTURE);
    const first = new FeedWatcher({ fetch: server.fetch, seen, clock: new FakeClock(NEWEST + HOUR) });
    await first.poll();

    // Restart 20h later: the lookback window still overlaps the already-seen videos.
    const second = new FeedWatcher({ fetch: server.fetch, seen, clock: new FakeClock(NEWEST + 21 * HOUR) });
    const r = await second.poll();
    expect(r.videos).toEqual([]);
    expect(r.skipped.seen).toBeGreaterThan(0);
  });

  it("picks up a new Bitcoin video on a later poll and passes conditional headers", async () => {
    const clock = new FakeClock(NEWEST + HOUR);
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({ fetch: server.fetch, seen: new InMemorySeenStore(), clock });
    await watcher.poll();
    expect(watcher.conditionalHeaders.etag).toBe('"v1"');

    clock.t += 10 * 60_000;
    server.notModified();
    const r304 = await watcher.poll();
    expect(r304.notModified).toBe(true);
    expect(r304.videos).toEqual([]);
    expect((server.calls[1]!.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');

    clock.t += 10 * 60_000;
    const publishedIso = new Date(clock.t - 60_000).toISOString();
    server.set(withNewEntry(FIXTURE, entry("NEWBTC12345", "Bitcoin Just Broke 80K - Now What?", publishedIso)));
    const emitted: string[] = [];
    watcher.on("video", (v) => emitted.push(v.videoId));
    const r = await watcher.poll();
    expect(r.videos.map((v) => v.videoId)).toEqual(["NEWBTC12345"]);
    expect(emitted).toEqual(["NEWBTC12345"]);
    expect(r.videos[0]!.publishedAt).toBe(Date.parse(publishedIso));
  });

  it("ignores a new non-Bitcoin video but records it as seen", async () => {
    const clock = new FakeClock(NEWEST + HOUR);
    const seen = new InMemorySeenStore();
    const server = feedServer(withNewEntry(FIXTURE, entry("NEWETH12345", "Ethereum Breaks Out", new Date(NEWEST + 30 * 60_000).toISOString())));
    const watcher = new FeedWatcher({ fetch: server.fetch, seen, clock });
    const r = await watcher.poll();
    expect(r.videos.map((v) => v.videoId)).toEqual(["3wXfppSKkpg"]);
    expect(seen.get("NEWETH12345")?.matched).toBe(false);
  });

  it("accepts a custom filter and honours explicit startedAt", async () => {
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({
      fetch: server.fetch,
      seen: new InMemorySeenStore(),
      clock: new FakeClock(NEWEST + 100 * HOUR),
      startedAt: NEWEST,
      lookbackMs: 2 * HOUR,
      filter: (v) => /ethereum/i.test(v.title),
    });
    const r = await watcher.poll();
    expect(r.videos.map((v) => v.videoId)).toEqual(["JUq2FuOWuX8"]);
  });

  it("retries a transient feed failure, then throws if it persists", async () => {
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({ fetch: server.fetch, seen: new InMemorySeenStore(), clock: new FakeClock(NEWEST + HOUR), fetchRetry: { attempts: 2, baseMs: 1 } });
    server.failNext(1);
    const r = await watcher.poll();
    expect(r.feedCount).toBe(15);
    expect(server.calls).toHaveLength(2);

    server.failNext(2);
    await expect(watcher.poll()).rejects.toThrow(/502/);
  });

  it("shares one in-flight poll between concurrent callers", async () => {
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({ fetch: server.fetch, seen: new InMemorySeenStore(), clock: new FakeClock(NEWEST + HOUR) });
    const [a, b] = await Promise.all([watcher.poll(), watcher.poll()]);
    expect(a).toBe(b);
    expect(server.calls).toHaveLength(1);
  });

  it("start/stop drive polling and route errors to the error event", async () => {
    const server = feedServer(FIXTURE);
    const watcher = new FeedWatcher({ fetch: server.fetch, seen: new InMemorySeenStore(), clock: new FakeClock(NEWEST + HOUR), fetchRetry: { attempts: 1 } });
    server.failNext(1);
    const errors: unknown[] = [];
    const polls: number[] = [];
    watcher.on("error", (e) => errors.push(e));
    watcher.on("poll", (r) => polls.push(r.feedCount));
    watcher.start(5);
    expect(watcher.running).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    watcher.stop();
    expect(watcher.running).toBe(false);
    expect(errors).toHaveLength(1);
    expect(polls.length).toBeGreaterThanOrEqual(1);
  });
});
