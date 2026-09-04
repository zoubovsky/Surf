import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

/** Minimal fetch signature so callers can inject a fake in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const YOUTUBE_FEED_URL = "https://www.youtube.com/feeds/videos.xml";
/** More Crypto Online channel id (verified live, see docs/research/03). */
export const MCO_CHANNEL_ID = "UCngIhBkikUe6e7tZTjpKK7Q";
/** Hidden "long-form only" uploads playlist: `UULF` + channel-id suffix. Excludes Shorts and live streams. */
export const MCO_LONGFORM_PLAYLIST_ID = "UULFngIhBkikUe6e7tZTjpKK7Q";

/** One `<entry>` of the YouTube Atom feed. Times are Unix ms. Text fields are untrusted data. */
export interface FeedVideo {
  videoId: string;
  title: string;
  publishedAt: number;
  updatedAt: number;
  url: string;
  channelId: string;
  /** `media:description`, truncated. Untrusted; never feed into tool arguments. */
  description: string;
}

export interface FeedMeta {
  title: string;
  channelId: string | null;
  playlistId: string | null;
  /** `<updated>`/`<published>` at feed level when present (Unix ms). */
  publishedAt: number | null;
}

export interface ParsedFeed {
  meta: FeedMeta;
  videos: FeedVideo[];
  /** Entries dropped because they failed validation. */
  skipped: number;
}

export interface FetchFeedOptions {
  /** Playlist feed (`playlist_id=`). Use the UULF playlist for long-form only. */
  playlistId?: string;
  /** Channel feed (`channel_id=`); includes Shorts. Ignored when `playlistId` is set. */
  channelId?: string;
  fetch: FetchLike;
  /** Previous `ETag` to send as `If-None-Match`. YouTube currently sends none, but the code honours it if it appears. */
  etag?: string | null;
  /** Previous `Last-Modified` to send as `If-Modified-Since`. */
  lastModified?: string | null;
  signal?: AbortSignal;
  /** Max bytes accepted from the feed body; larger bodies are rejected. */
  maxBytes?: number;
}

export interface FeedResponseInfo {
  url: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
}

export type FetchFeedResult =
  | ({ notModified: true } & FeedResponseInfo)
  | ({ notModified: false } & FeedResponseInfo & ParsedFeed);

export class FeedFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export function buildFeedUrl(opts: { playlistId?: string; channelId?: string }): string {
  const u = new URL(YOUTUBE_FEED_URL);
  if (opts.playlistId) u.searchParams.set("playlist_id", opts.playlistId);
  else if (opts.channelId) u.searchParams.set("channel_id", opts.channelId);
  else throw new Error("buildFeedUrl: playlistId or channelId is required");
  return u.toString();
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 4000;

const str = z.string();
const Link = z.object({ "@_rel": z.string().optional(), "@_href": z.string() }).passthrough();

const RawEntry = z
  .object({
    "yt:videoId": z.string().regex(VIDEO_ID_RE),
    "yt:channelId": z.string().optional(),
    title: str.optional(),
    published: str,
    updated: str.optional(),
    link: z.array(Link).optional(),
    "media:group": z
      .object({ "media:title": str.optional(), "media:description": str.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const RawFeed = z
  .object({
    feed: z
      .object({
        title: str.optional(),
        "yt:channelId": str.optional(),
        "yt:playlistId": str.optional(),
        published: str.optional(),
        updated: str.optional(),
        entry: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep everything as strings: a numeric-looking title must not become a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jpath) => jpath === "feed.entry" || jpath === "feed.entry.link",
});

function parseDate(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Parse a YouTube Atom feed body. Pure; safe to call on untrusted XML (bad entries are skipped). */
export function parseFeed(xml: string, fallbackChannelId: string | null = null): ParsedFeed {
  let raw: unknown;
  try {
    raw = parser.parse(xml);
  } catch (err) {
    throw new Error(`parseFeed: invalid XML: ${(err as Error).message}`);
  }
  const feedRes = RawFeed.safeParse(raw);
  if (!feedRes.success) throw new Error("parseFeed: document is not a YouTube Atom feed");
  const feed = feedRes.data.feed;
  const feedChannelId = feed["yt:channelId"] ?? fallbackChannelId;

  const videos: FeedVideo[] = [];
  let skipped = 0;
  for (const item of feed.entry ?? []) {
    const e = RawEntry.safeParse(item);
    if (!e.success) {
      skipped++;
      continue;
    }
    const d = e.data;
    const publishedAt = parseDate(d.published);
    if (publishedAt === null) {
      skipped++;
      continue;
    }
    const videoId = d["yt:videoId"];
    const channelId = d["yt:channelId"] ?? feedChannelId;
    if (!channelId) {
      skipped++;
      continue;
    }
    const alt = d.link?.find((l) => l["@_rel"] === "alternate") ?? d.link?.[0];
    const url = alt && /^https:\/\/(www\.)?youtube\.com\//.test(alt["@_href"])
      ? alt["@_href"]
      : `https://www.youtube.com/watch?v=${videoId}`;
    const title = clip((d.title ?? d["media:group"]?.["media:title"] ?? "").replace(/\s+/g, " ").trim(), MAX_TITLE);
    videos.push({
      videoId,
      title,
      publishedAt,
      updatedAt: parseDate(d.updated) ?? publishedAt,
      url,
      channelId,
      description: clip(d["media:group"]?.["media:description"] ?? "", MAX_DESCRIPTION),
    });
  }

  return {
    meta: {
      title: feed.title ?? "",
      channelId: feedChannelId,
      playlistId: feed["yt:playlistId"] ?? null,
      publishedAt: parseDate(feed.published) ?? parseDate(feed.updated),
    },
    videos,
    skipped,
  };
}

/**
 * Fetch and parse a YouTube feed, with conditional-request support.
 * Returns `{ notModified: true }` on HTTP 304 so the caller can keep its previous state.
 * Throws `FeedFetchError` on any other non-2xx status.
 */
export async function fetchLongFormFeed(opts: FetchFeedOptions): Promise<FetchFeedResult> {
  const url = buildFeedUrl(opts);
  const headers: Record<string, string> = {
    accept: "application/atom+xml, application/xml, text/xml",
    "user-agent": "surf-ingestion/0.1 (+feed poller)",
  };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

  const init: RequestInit = { method: "GET", headers, redirect: "follow" };
  if (opts.signal) init.signal = opts.signal;
  const res = await opts.fetch(url, init);

  const info: FeedResponseInfo = {
    url,
    status: res.status,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
  if (res.status === 304) return { notModified: true, ...info };
  if (!res.ok) throw new FeedFetchError(`feed request failed with HTTP ${res.status}`, res.status, url);

  const body = await res.text();
  const maxBytes = opts.maxBytes ?? 5_000_000;
  if (body.length > maxBytes) throw new FeedFetchError(`feed body exceeds ${maxBytes} bytes`, res.status, url);

  const parsed = parseFeed(body, opts.channelId ?? null);
  return { notModified: false, ...info, ...parsed };
}
