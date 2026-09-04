import { createLogger, retry, systemClock, type Clock, type Logger } from "@surf/core";
import { fetchLongFormFeed, MCO_LONGFORM_PLAYLIST_ID, type FeedVideo, type FetchLike } from "./feed.js";
import { isBitcoinTitle } from "./filter.js";

export interface SeenMeta {
  title: string;
  publishedAt: number;
  url: string;
  channelId: string;
  /** Whether the video passed the title filter (only matched videos are emitted). */
  matched: boolean;
  seenAt: number;
}

/**
 * Persistence for the "already processed" set. The daemon implements this in SQLite;
 * `InMemorySeenStore` is provided for tests and one-off scripts. Methods may be sync or async.
 */
export interface SeenStore {
  has(videoId: string): boolean | Promise<boolean>;
  add(videoId: string, meta: SeenMeta): void | Promise<void>;
}

export class InMemorySeenStore implements SeenStore {
  private readonly map = new Map<string, SeenMeta>();
  has(videoId: string): boolean {
    return this.map.has(videoId);
  }
  add(videoId: string, meta: SeenMeta): void {
    this.map.set(videoId, meta);
  }
  get(videoId: string): SeenMeta | undefined {
    return this.map.get(videoId);
  }
  get size(): number {
    return this.map.size;
  }
  entries(): [string, SeenMeta][] {
    return Array.from(this.map.entries());
  }
}

export interface FeedWatcherOptions {
  fetch: FetchLike;
  seen: SeenStore;
  clock?: Clock;
  logger?: Logger;
  /** Defaults to the MCO long-form playlist. */
  playlistId?: string;
  /** Use a channel feed instead of a playlist (includes Shorts; pair with a duration check). */
  channelId?: string;
  /** Videos published before `startedAt - lookbackMs` are ignored. Default 24h. */
  lookbackMs?: number;
  /** Override the reference time for the lookback window (defaults to `clock.now()` at construction). */
  startedAt?: number;
  /** Which videos to emit. Default: `isBitcoinTitle(video.title)`. */
  filter?: (video: FeedVideo) => boolean;
  /** Transient-failure retry for the feed request. Default 2 attempts, 500ms base. */
  fetchRetry?: { attempts?: number; baseMs?: number };
}

export interface PollResult {
  /** Newly detected videos that passed the filter, oldest first. */
  videos: FeedVideo[];
  notModified: boolean;
  /** Entries in the feed response (0 on 304). */
  feedCount: number;
  skipped: { tooOld: number; seen: number; filtered: number };
  at: number;
}

interface WatcherEvents {
  video: (video: FeedVideo) => void;
  poll: (result: PollResult) => void;
  error: (err: unknown) => void;
}

export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Polls the YouTube feed and emits Bitcoin long-form videos exactly once each.
 * Restart-safe: with a persistent `SeenStore` plus the lookback window, a restart never
 * re-ingests history older than `lookbackMs` and never re-emits an already-seen video.
 */
export class FeedWatcher {
  readonly startedAt: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly lookbackMs: number;
  private readonly filter: (video: FeedVideo) => boolean;
  private readonly listeners: { [K in keyof WatcherEvents]: Set<WatcherEvents[K]> } = {
    video: new Set(),
    poll: new Set(),
    error: new Set(),
  };
  private etag: string | null = null;
  private lastModified: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<PollResult> | null = null;

  constructor(private readonly opts: FeedWatcherOptions) {
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? createLogger("silent", "ingestion");
    this.lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.startedAt = opts.startedAt ?? this.clock.now();
    this.filter = opts.filter ?? ((v) => isBitcoinTitle(v.title));
  }

  on<K extends keyof WatcherEvents>(event: K, cb: WatcherEvents[K]): () => void {
    const set = this.listeners[event] as Set<WatcherEvents[K]>;
    set.add(cb);
    return () => set.delete(cb);
  }

  private emit<K extends keyof WatcherEvents>(event: K, ...args: Parameters<WatcherEvents[K]>): void {
    for (const cb of this.listeners[event] as Set<(...a: Parameters<WatcherEvents[K]>) => void>) {
      try {
        cb(...args);
      } catch (err) {
        this.logger.error({ err, event }, "watcher listener threw");
      }
    }
  }

  /** Cached validators from the last successful feed response. */
  get conditionalHeaders(): { etag: string | null; lastModified: string | null } {
    return { etag: this.etag, lastModified: this.lastModified };
  }

  /**
   * Fetch the feed once and return newly detected videos that pass the filter.
   * Concurrent calls share one in-flight poll. Throws on feed fetch failure (after retry).
   */
  poll(): Promise<PollResult> {
    if (this.polling) return this.polling;
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<PollResult> {
    const source =
      this.opts.channelId && !this.opts.playlistId
        ? { channelId: this.opts.channelId }
        : { playlistId: this.opts.playlistId ?? MCO_LONGFORM_PLAYLIST_ID };
    const res = await retry(
      () =>
        fetchLongFormFeed({
          ...source,
          fetch: this.opts.fetch,
          etag: this.etag,
          lastModified: this.lastModified,
        }),
      {
        attempts: this.opts.fetchRetry?.attempts ?? 2,
        baseMs: this.opts.fetchRetry?.baseMs ?? 500,
        onError: (err, attempt) => this.logger.warn({ err, attempt }, "feed fetch failed"),
      },
    );

    const at = this.clock.now();
    const result: PollResult = {
      videos: [],
      notModified: res.notModified,
      feedCount: 0,
      skipped: { tooOld: 0, seen: 0, filtered: 0 },
      at,
    };
    if (res.notModified) {
      this.emit("poll", result);
      return result;
    }
    this.etag = res.etag;
    this.lastModified = res.lastModified;
    result.feedCount = res.videos.length;
    const cutoff = this.startedAt - this.lookbackMs;

    // Oldest first so downstream processes videos in publication order.
    const ordered = [...res.videos].sort((a, b) => a.publishedAt - b.publishedAt);
    for (const video of ordered) {
      if (video.publishedAt < cutoff) {
        result.skipped.tooOld++;
        continue;
      }
      if (await this.opts.seen.has(video.videoId)) {
        result.skipped.seen++;
        continue;
      }
      const matched = this.filter(video);
      await this.opts.seen.add(video.videoId, {
        title: video.title,
        publishedAt: video.publishedAt,
        url: video.url,
        channelId: video.channelId,
        matched,
        seenAt: at,
      });
      if (!matched) {
        result.skipped.filtered++;
        continue;
      }
      result.videos.push(video);
    }

    this.logger.info(
      { feedCount: result.feedCount, newVideos: result.videos.length, skipped: result.skipped },
      "feed polled",
    );
    for (const v of result.videos) this.emit("video", v);
    this.emit("poll", result);
    return result;
  }

  /** Poll now and then every `intervalMs` (default 5 min). Errors are emitted, never thrown. */
  start(intervalMs = 5 * 60 * 1000): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.logger.error({ err }, "feed poll failed");
        this.emit("error", err);
      }
      if (this.timer !== null) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
