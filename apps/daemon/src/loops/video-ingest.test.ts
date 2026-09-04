import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TranscriptBlockedError } from "@surf/ingestion";
import type { Transcript, TranscriptProvider } from "@surf/ingestion";
import { createLogger } from "@surf/core";
import { schema } from "../db/index.js";
import { buildHarness, H, T0, VIDEO_ID, type Harness } from "../testing/harness.js";
import { fakeLlm } from "../testing/fake-llm.js";
import { videoIngest, TRANSCRIPT_RETRY_SCHEDULE_MS } from "./video-ingest.js";

const MIN = 60_000;
const log = createLogger("silent");

function seedVideo(h: Harness, status = "new"): void {
  h.db
    .insert(schema.videos)
    .values({
      videoId: VIDEO_ID,
      title: "Bitcoin Price: Why 79K Is the Level to Watch Today",
      publishedAt: T0 - H,
      seenAt: T0,
      status,
    })
    .run();
}

function pendingProvider(): TranscriptProvider & { calls: number } {
  const p = {
    name: "pending",
    calls: 0,
    async fetch(): Promise<Transcript | null> {
      p.calls++;
      return null;
    },
  };
  return p;
}

describe("video-ingest", () => {
  it("re-enqueues itself on the 20/40/80/160 min schedule and gives up after 6h", async () => {
    const h = buildHarness({ transcript: null, llm: null });
    const provider = pendingProvider();
    h.app.ctx.transcripts = new (await import("@surf/ingestion")).TranscriptChain([provider], {
      clock: { now: () => h.scenario.now },
    });
    seedVideo(h);
    let attempt = 0;
    const expected = [20, 40, 80, 160].map((m) => m * MIN);
    for (const delay of expected) {
      const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt }, log);
      attempt++;
      expect(r.terminal).toBe("transcript-pending");
      expect(r.nextRunAt).toBe(h.scenario.now + delay);
      const job = h.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.singletonKey, `video-ingest-${VIDEO_ID}-${attempt}`))
        .get();
      expect(job?.runAt).toBe(h.scenario.now + delay);
      const v = h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!;
      expect(v.status).toBe("transcript-pending");
      expect(v.attempts).toBe(attempt);
      h.advance(delay);
    }
    // 20+40+80+160 = 300 min elapsed; the next retry (+160 = 460 min) would exceed the 6h deadline
    const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt }, log);
    expect(r.terminal).toBe("transcript-unavailable");
    expect(h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "unavailable",
    );
    expect(provider.calls).toBe(5);
    expect(TRANSCRIPT_RETRY_SCHEDULE_MS).toEqual([20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN]);
    await h.app.notifier.flush();
    expect(h.tg!.texts().some((t) => /Transcript unavailable/.test(t))).toBe(true);
  });

  it("marks the video unavailable and sends a critical notice when every provider is blocked", async () => {
    const h = buildHarness({ transcript: null, llm: null });
    const blocked: TranscriptProvider = {
      name: "b",
      async fetch() {
        throw new TranscriptBlockedError("captcha");
      },
    };
    h.app.ctx.transcripts = new (await import("@surf/ingestion")).TranscriptChain([blocked], {
      clock: { now: () => h.scenario.now },
    });
    seedVideo(h);
    const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt: 0 }, log);
    expect(r.terminal).toBe("blocked");
    await h.app.notifier.flush();
    expect(h.tg!.texts().at(-1)).toMatch(/blocked/);
    expect(h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "unavailable",
    );
  });

  it("stores the transcript, triages, extracts the prior and enqueues a video decision cycle", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0, videoId: VIDEO_ID });
    const h = buildHarness({ llm });
    seedVideo(h);
    const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt: 0 }, log);
    expect(r.terminal).toBe("ingested");
    expect(r.cycleEnqueued).toBe(true);
    expect(h.db.select().from(schema.transcripts).all()).toHaveLength(1);
    const signal = h.db.select().from(schema.signals).where(eq(schema.signals.videoId, VIDEO_ID)).get()!;
    expect((signal.prior as { videoId: string }).videoId).toBe(VIDEO_ID);
    expect(h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "ingested",
    );
    const job = h.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.singletonKey, `video-${VIDEO_ID}`))
      .get()!;
    expect(job.kind).toBe("hourly-cycle");
    expect(job.payload).toEqual({ cycleId: `video-${VIDEO_ID}`, kind: "video", videoId: VIDEO_ID });
    expect(llm.parseCalls.map((c) => c.params.model)).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect(h.app.ctx.state.get().llmSpendTodayUsd).toBeGreaterThan(0);
    await h.app.notifier.flush();
    expect(h.tg!.texts().at(-1)).toMatch(/Video ingested/);
  });

  it("records a triage-only signal for irrelevant videos", async () => {
    const llm = fakeLlm({
      mark: 79_780,
      now: T0,
      triage: { relevant: true, isBitcoinAnalysis: false, substantive: true, reason: "altcoin talk" },
    });
    const h = buildHarness({ llm });
    seedVideo(h);
    const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt: 0 }, log);
    expect(r.terminal).toBe("not-relevant");
    const signal = h.db.select().from(schema.signals).where(eq(schema.signals.videoId, VIDEO_ID)).get()!;
    expect(signal.prior).toBeNull();
    expect(llm.parseCalls).toHaveLength(1);
  });

  it("reports blocked without an LLM client but keeps the transcript", async () => {
    const h = buildHarness({ llm: null });
    seedVideo(h);
    const r = await videoIngest(h.app.ctx, { videoId: VIDEO_ID, attempt: 0 }, log);
    expect(r.terminal).toBe("blocked");
    expect(h.db.select().from(schema.transcripts).all()).toHaveLength(1);
    expect(h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "blocked",
    );
  });
});
