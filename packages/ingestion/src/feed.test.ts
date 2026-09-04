import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFeedUrl, FeedFetchError, fetchLongFormFeed, MCO_CHANNEL_ID, MCO_LONGFORM_PLAYLIST_ID, parseFeed, type FetchLike } from "./feed.js";

const FIXTURE = readFileSync(new URL("./__fixtures__/uulf-feed.xml", import.meta.url), "utf8");

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): FetchLike & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(init ? { url, init } : { url });
    return handler(url, init);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("parseFeed (live UULF fixture, 2026-09-04)", () => {
  const parsed = parseFeed(FIXTURE);

  it("parses feed metadata", () => {
    expect(parsed.meta).toEqual({
      title: "Videos",
      channelId: MCO_CHANNEL_ID,
      playlistId: MCO_LONGFORM_PLAYLIST_ID,
      publishedAt: Date.parse("2021-10-13T07:10:08+00:00"),
    });
  });

  it("parses all 15 entries with no skips", () => {
    expect(parsed.videos).toHaveLength(15);
    expect(parsed.skipped).toBe(0);
    expect(parsed.videos.map((v) => v.videoId)).toEqual([
      "JUq2FuOWuX8", "3wXfppSKkpg", "uXa-onE9qsw", "UM38dzo6n5c", "DQhNm7yGRDo", "PdMTVWEBsho", "bBNu9b3HyWw",
      "2S4u329EsSc", "rsLjW9aDPeg", "cQ38rSa1DCI", "qzQ2pUZlmGg", "u6ltPTHxj_U", "GTTRvGpgLXI", "6XF4x2QilUY", "dv_XIROh0Q4",
    ]);
  });

  it("maps entry fields", () => {
    const v = parsed.videos[1]!;
    expect(v).toMatchObject({
      videoId: "3wXfppSKkpg",
      title: "Bitcoin Price: Why 79K Is the Level to Watch Today",
      url: "https://www.youtube.com/watch?v=3wXfppSKkpg",
      channelId: MCO_CHANNEL_ID,
      publishedAt: Date.parse("2026-09-04T13:03:03+00:00"),
      updatedAt: Date.parse("2026-09-04T16:28:55+00:00"),
    });
    expect(v.updatedAt).toBeGreaterThan(v.publishedAt);
    expect(parsed.videos[0]!.description).toContain("Invalidation: $2,355");
  });

  it("emits newest first as in the feed and every id is 11 chars", () => {
    for (let i = 1; i < parsed.videos.length; i++) expect(parsed.videos[i]!.publishedAt).toBeLessThanOrEqual(parsed.videos[i - 1]!.publishedAt);
    for (const v of parsed.videos) expect(v.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });
});

describe("parseFeed (edge cases)", () => {
  const wrap = (entries: string, channel = `<yt:channelId>${MCO_CHANNEL_ID}</yt:channelId>`) =>
    `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">${channel}<title>Videos</title>${entries}</feed>`;

  it("keeps numeric-looking titles as strings and decodes entities", () => {
    const xml = wrap(
      `<entry><yt:videoId>abcdefghijk</yt:videoId><title>2026</title><published>2026-09-04T00:00:00+00:00</published></entry>
       <entry><yt:videoId>abcdefghijl</yt:videoId><title>Bitcoin &amp; Ethereum: Levels</title><published>2026-09-04T00:00:00+00:00</published></entry>`,
    );
    const p = parseFeed(xml);
    expect(p.videos[0]!.title).toBe("2026");
    expect(p.videos[1]!.title).toBe("Bitcoin & Ethereum: Levels");
    expect(p.videos[1]!.url).toBe("https://www.youtube.com/watch?v=abcdefghijl");
  });

  it("skips malformed entries instead of failing", () => {
    const xml = wrap(
      `<entry><yt:videoId>bad id!</yt:videoId><title>x</title><published>2026-09-04T00:00:00+00:00</published></entry>
       <entry><yt:videoId>abcdefghijk</yt:videoId><title>x</title><published>not a date</published></entry>
       <entry><yt:videoId>abcdefghijm</yt:videoId><title>ok</title><published>2026-09-04T00:00:00+00:00</published></entry>`,
    );
    const p = parseFeed(xml);
    expect(p.skipped).toBe(2);
    expect(p.videos.map((v) => v.videoId)).toEqual(["abcdefghijm"]);
  });

  it("ignores non-youtube alternate links", () => {
    const xml = wrap(
      `<entry><yt:videoId>abcdefghijk</yt:videoId><title>x</title><link rel="alternate" href="https://evil.example/phish"/><published>2026-09-04T00:00:00+00:00</published></entry>`,
    );
    expect(parseFeed(xml).videos[0]!.url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
  });

  it("handles an empty feed and rejects non-feeds", () => {
    expect(parseFeed(wrap("")).videos).toEqual([]);
    expect(() => parseFeed("<html></html>")).toThrow(/not a YouTube Atom feed/);
    expect(() => parseFeed("<<<")).toThrow(/invalid XML/);
  });
});

describe("fetchLongFormFeed", () => {
  it("builds playlist and channel URLs", () => {
    expect(buildFeedUrl({ playlistId: MCO_LONGFORM_PLAYLIST_ID })).toBe(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=UULFngIhBkikUe6e7tZTjpKK7Q",
    );
    expect(buildFeedUrl({ channelId: MCO_CHANNEL_ID })).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UCngIhBkikUe6e7tZTjpKK7Q");
    expect(() => buildFeedUrl({})).toThrow();
  });

  it("fetches, parses and returns validators", async () => {
    const fetch = fakeFetch(() => new Response(FIXTURE, { status: 200, headers: { etag: '"abc"', "last-modified": "Fri, 04 Sep 2026 16:54:03 GMT" } }));
    const res = await fetchLongFormFeed({ playlistId: MCO_LONGFORM_PLAYLIST_ID, fetch });
    expect(res.notModified).toBe(false);
    if (res.notModified) throw new Error("unreachable");
    expect(res.videos).toHaveLength(15);
    expect(res.etag).toBe('"abc"');
    expect(res.lastModified).toBe("Fri, 04 Sep 2026 16:54:03 GMT");
    expect(fetch.calls[0]!.url).toContain("playlist_id=UULFngIhBkikUe6e7tZTjpKK7Q");
    const headers = fetch.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBeUndefined();
  });

  it("sends If-None-Match / If-Modified-Since and handles 304", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 304 }));
    const res = await fetchLongFormFeed({ playlistId: MCO_LONGFORM_PLAYLIST_ID, fetch, etag: '"abc"', lastModified: "Fri, 04 Sep 2026 16:54:03 GMT" });
    expect(res.notModified).toBe(true);
    expect(res.status).toBe(304);
    const headers = fetch.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('"abc"');
    expect(headers["if-modified-since"]).toBe("Fri, 04 Sep 2026 16:54:03 GMT");
  });

  it("supports channel_id feeds", async () => {
    const fetch = fakeFetch(() => new Response(FIXTURE, { status: 200 }));
    const res = await fetchLongFormFeed({ channelId: MCO_CHANNEL_ID, fetch });
    expect(fetch.calls[0]!.url).toContain("channel_id=UCngIhBkikUe6e7tZTjpKK7Q");
    expect(res.notModified).toBe(false);
  });

  it("throws FeedFetchError on non-2xx", async () => {
    const fetch = fakeFetch(() => new Response("nope", { status: 503 }));
    await expect(fetchLongFormFeed({ playlistId: MCO_LONGFORM_PLAYLIST_ID, fetch })).rejects.toBeInstanceOf(FeedFetchError);
  });

  it("rejects oversized bodies", async () => {
    const fetch = fakeFetch(() => new Response(FIXTURE, { status: 200 }));
    await expect(fetchLongFormFeed({ playlistId: MCO_LONGFORM_PLAYLIST_ID, fetch, maxBytes: 1000 })).rejects.toThrow(/exceeds/);
  });
});
