import type { Logger } from "@surf/core";
import type { FeedWatcher } from "@surf/ingestion";
import { escapeHtml } from "@surf/telegram";
import type { AppContext } from "../context.js";

/** Delay between detection and the first transcript attempt (captions rarely exist immediately). */
export const INGEST_DELAY_MS = 10 * 60_000;

export const videoIngestSingleton = (videoId: string, attempt = 0): string =>
  attempt === 0 ? `video-ingest-${videoId}` : `video-ingest-${videoId}-${attempt}`;

export async function feedPoll(ctx: AppContext, watcher: FeedWatcher, log: Logger): Promise<unknown> {
  const now = ctx.now();
  let result;
  try {
    result = await watcher.poll();
  } catch (err) {
    ctx.health.markFeed("youtube-feed", "down", err instanceof Error ? err.message : String(err), now);
    throw err;
  }
  ctx.health.markFeed("youtube-feed", "ok", null, now);
  const enqueued: string[] = [];
  for (const v of result.videos) {
    const id = ctx.runner.enqueue("video-ingest", {
      singletonKey: videoIngestSingleton(v.videoId),
      payload: { videoId: v.videoId, attempt: 0 },
      runAt: now + INGEST_DELAY_MS,
      maxAttempts: 3,
    });
    if (id) enqueued.push(v.videoId);
    void ctx.notifier.notify(
      "info",
      `🎬 <b>New MCO Bitcoin video detected</b>: ${escapeHtml(v.title)}\n<code>${escapeHtml(v.videoId)}</code>`,
    );
    log.info({ videoId: v.videoId, title: v.title }, "new video detected");
  }
  return { feedCount: result.feedCount, newVideos: result.videos.length, enqueued, skipped: result.skipped };
}
