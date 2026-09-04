import { eq } from "drizzle-orm";
import type { Logger } from "@surf/core";
import { extractPrior, triage, UnsupportedPriorError, type TriageResult } from "@surf/agents";
import { cleanTranscript, windowByKeyword, type Transcript } from "@surf/ingestion";
import { escapeHtml, formatError, formatPrior } from "@surf/telegram";
import type { AppContext } from "../context.js";
import { kvGet, schema } from "../db/index.js";
import { KV, getLastCycle } from "../db/queries.js";
import { videoIngestSingleton } from "./feed-poll.js";

const MIN = 60_000;
export const TRANSCRIPT_RETRY_SCHEDULE_MS = [20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN];
export const TRANSCRIPT_DEADLINE_MS = 6 * 60 * MIN;
/** A fresh video does not trigger a decision cycle when one ran this recently. */
export const VIDEO_CYCLE_MIN_GAP_MS = 15 * MIN;

export interface VideoIngestPayload {
  videoId: string;
  attempt?: number;
}

export interface VideoIngestResult {
  videoId: string;
  terminal: "ingested" | "not-relevant" | "transcript-pending" | "transcript-unavailable" | "blocked";
  detail: string;
  nextRunAt?: number;
  cycleEnqueued?: boolean;
}

export function retryDelayMs(attempt: number): number {
  return TRANSCRIPT_RETRY_SCHEDULE_MS[Math.min(attempt, TRANSCRIPT_RETRY_SCHEDULE_MS.length - 1)]!;
}

/**
 * Loop A. Single transcript pass per job run; the daemon owns the retry schedule via re-enqueue
 * (20/40/80/160 min, giving up 6h after detection). Triage (Haiku) then extraction (Opus).
 */
export async function videoIngest(
  ctx: AppContext,
  payload: VideoIngestPayload,
  log: Logger,
): Promise<VideoIngestResult> {
  const now = ctx.now();
  const { videoId } = payload;
  const video = ctx.db.select().from(schema.videos).where(eq(schema.videos.videoId, videoId)).get();
  if (!video) return { videoId, terminal: "not-relevant", detail: "unknown video" };
  if (video.status === "ingested" || video.status === "not-relevant" || video.status === "unavailable") {
    return {
      videoId,
      terminal:
        video.status === "ingested"
          ? "ingested"
          : video.status === "unavailable"
            ? "transcript-unavailable"
            : "not-relevant",
      detail: `already ${video.status}`,
    };
  }
  const setVideo = (patch: Partial<typeof schema.videos.$inferSelect>) =>
    ctx.db.update(schema.videos).set(patch).where(eq(schema.videos.videoId, videoId)).run();

  let transcript: Transcript | null = ctx.db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.videoId, videoId))
    .get()
    ? (() => {
        const t = ctx.db
          .select()
          .from(schema.transcripts)
          .where(eq(schema.transcripts.videoId, videoId))
          .get()!;
        return {
          videoId,
          language: t.language,
          source: t.source,
          text: t.text,
          segments: (t.segments as Transcript["segments"]) ?? [],
          fetchedAt: t.fetchedAt,
        } as Transcript;
      })()
    : null;

  if (!transcript) {
    if (!ctx.transcripts) {
      setVideo({ status: "unavailable", note: "no transcript providers configured", lastAttemptAt: now });
      ctx.health.markFeed("transcripts", "down", "no providers configured", now);
      return { videoId, terminal: "transcript-unavailable", detail: "no transcript providers configured" };
    }
    const attempt = (payload.attempt ?? video.attempts) + 1;
    const r = await ctx.transcripts.fetch(videoId);
    if (!r.transcript) {
      if (r.blocked) {
        setVideo({
          status: "unavailable",
          attempts: attempt,
          lastAttemptAt: now,
          note: "all transcript providers blocked",
        });
        ctx.health.markFeed(
          "transcripts",
          "down",
          r.attempts.map((a) => `${a.provider}:${a.outcome}`).join(", "),
          now,
        );
        void ctx.notifier.notify(
          "critical",
          formatError({
            context: "video-ingest",
            message: `every transcript provider is blocked for ${videoId}: ${r.attempts.map((a) => `${a.provider}=${a.outcome} ${a.error ?? ""}`).join("; ")}`,
            at: now,
            terminal: "blocked",
          }),
        );
        return { videoId, terminal: "blocked", detail: "all providers blocked" };
      }
      const delay = Math.max(retryDelayMs(attempt - 1), ...r.attempts.map((a) => a.retryAfterMs ?? 0));
      const nextRunAt = now + delay;
      if (nextRunAt - video.seenAt > TRANSCRIPT_DEADLINE_MS) {
        setVideo({
          status: "unavailable",
          attempts: attempt,
          lastAttemptAt: now,
          note: `no transcript after ${attempt} attempts / ${Math.round((now - video.seenAt) / MIN)} min`,
        });
        ctx.health.markFeed("transcripts", "degraded", `gave up on ${videoId}`, now);
        void ctx.notifier.notify(
          "warn",
          `⚠️ <b>Transcript unavailable</b> for ${escapeHtml(video.title)} (<code>${escapeHtml(videoId)}</code>) after ${attempt} attempts; giving up.`,
        );
        return { videoId, terminal: "transcript-unavailable", detail: "deadline exceeded" };
      }
      setVideo({ status: "transcript-pending", attempts: attempt, lastAttemptAt: now });
      ctx.runner.enqueue("video-ingest", {
        singletonKey: videoIngestSingleton(videoId, attempt),
        payload: { videoId, attempt },
        runAt: nextRunAt,
        maxAttempts: 3,
      });
      log.info({ videoId, attempt, nextRunAt }, "transcript pending; re-enqueued");
      return {
        videoId,
        terminal: "transcript-pending",
        detail: `attempt ${attempt}; retry in ${delay / MIN} min`,
        nextRunAt,
      };
    }
    transcript = r.transcript;
    ctx.health.markFeed("transcripts", "ok", null, now);
    ctx.db
      .insert(schema.transcripts)
      .values({
        videoId,
        language: transcript.language,
        source: transcript.source,
        text: transcript.text,
        segments: transcript.segments,
        fetchedAt: transcript.fetchedAt,
      })
      .onConflictDoNothing()
      .run();
    setVideo({ attempts: (payload.attempt ?? video.attempts) + 1, lastAttemptAt: now });
  }

  if (!ctx.llm) {
    setVideo({ status: "blocked", note: "transcript saved; no LLM client configured" });
    ctx.health.markFeed("llm", "down", "no ANTHROPIC_API_KEY", now);
    return { videoId, terminal: "blocked", detail: "no LLM client" };
  }

  const clean = cleanTranscript(transcript);
  const windows = windowByKeyword(clean).map((w) => w.text);
  const tri = await triage({ client: ctx.llm, model: ctx.models.triage }, clean.text, video.title);
  ctx.state.recordLlmSpend(tri.usage.costUsd);
  const t: TriageResult = tri.output;
  const relevant = t.relevant && t.isBitcoinAnalysis && t.substantive;
  if (!relevant) {
    ctx.db
      .insert(schema.signals)
      .values({ videoId, publishedAt: video.publishedAt, triage: t, prior: null, createdAt: now })
      .onConflictDoNothing()
      .run();
    setVideo({ status: "not-relevant", note: t.reason });
    void ctx.notifier.notify(
      "info",
      `🎬 <b>Video not relevant</b> · ${escapeHtml(video.title)}\n${escapeHtml(t.reason)}`,
    );
    return { videoId, terminal: "not-relevant", detail: t.reason };
  }

  try {
    const ex = await extractPrior(
      { client: ctx.llm, model: ctx.models.analyst },
      {
        videoId,
        title: video.title,
        publishedAt: video.publishedAt,
        transcriptText: clean.text,
        keywordWindows: windows.slice(0, 40),
      },
    );
    ctx.state.recordLlmSpend(ex.usage.costUsd);
    ctx.db
      .insert(schema.signals)
      .values({ videoId, publishedAt: video.publishedAt, triage: t, prior: ex.output, createdAt: now })
      .onConflictDoUpdate({
        target: schema.signals.videoId,
        set: { prior: ex.output, triage: t, createdAt: now },
      })
      .run();
    setVideo({
      status: "ingested",
      note: ex.verification.confidenceLowered ? "evidence check lowered confidence" : null,
    });
    void ctx.notifier.notify("warn", formatPrior(ex.output));
    ctx.health.markFeed("llm", "ok", null, now);
  } catch (err) {
    if (err instanceof UnsupportedPriorError) {
      ctx.db
        .insert(schema.signals)
        .values({
          videoId,
          publishedAt: video.publishedAt,
          triage: { ...t, reason: `unsupported prior: ${err.message}` },
          prior: null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
      setVideo({ status: "not-relevant", note: `no verifiable levels: ${err.message}`.slice(0, 500) });
      void ctx.notifier.notify(
        "info",
        `🎬 <b>Video ingested without usable levels</b> · ${escapeHtml(video.title)}\n${escapeHtml(err.message)}`,
      );
      return { videoId, terminal: "not-relevant", detail: `unsupported prior: ${err.message}` };
    }
    throw err;
  }

  // Trigger a decision cycle unless one ran very recently (the next hourly cycle sees the new signal anyway).
  const last = getLastCycle(ctx.db);
  const lastVideoAt = kvGet<number>(ctx.db, KV.lastVideoDecisionAt);
  const recent =
    (last && now - last.at < VIDEO_CYCLE_MIN_GAP_MS) ||
    (lastVideoAt !== null && now - lastVideoAt < VIDEO_CYCLE_MIN_GAP_MS);
  let cycleEnqueued = false;
  if (!recent) {
    const id = ctx.runner.enqueue("hourly-cycle", {
      singletonKey: `video-${videoId}`,
      payload: { cycleId: `video-${videoId}`, kind: "video", videoId },
      maxAttempts: 2,
    });
    cycleEnqueued = id !== null;
  }
  return { videoId, terminal: "ingested", detail: "prior extracted", cycleEnqueued };
}
