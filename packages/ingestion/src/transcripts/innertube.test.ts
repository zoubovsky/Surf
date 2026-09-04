import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../feed.js";
import { TranscriptBlockedError, TranscriptError } from "./errors.js";
import {
  captionTracksOf,
  detectBlock,
  extractInnertubeApiKey,
  extractJsonObject,
  extractPlayerResponse,
  InnertubeProvider,
  selectCaptionTrack,
  type CaptionTrack,
} from "./innertube.js";
import { parseJson3, parseTimedText, parseTimedTextXml } from "./timedtext.js";

const fx = (name: string) => readFileSync(new URL(`../__fixtures__/innertube/${name}`, import.meta.url), "utf8");
const WATCH = fx("watch-page.html");
const JSON3 = fx("captions.json3");
const BLOCKED = fx("blocked-recaptcha.html");
const LOGIN_REQUIRED = fx("player-login-required.json");

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
function router(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => u.href.startsWith(k) || u.pathname.startsWith(k));
    if (!key) throw new Error(`no route for ${url}`);
    return routes[key]!(u, init ?? {});
  };
  return { fetch, calls };
}

describe("player response extraction", () => {
  it("extracts INNERTUBE_API_KEY and ytInitialPlayerResponse from the watch page", () => {
    expect(extractInnertubeApiKey(WATCH)).toBe("AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8");
    const player = extractPlayerResponse(WATCH);
    expect(player?.playabilityStatus?.status).toBe("OK");
    const tracks = captionTracksOf(player);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ languageCode: "en", kind: "asr", vssId: "a.en", name: "English (auto-generated)" });
    expect(tracks[0]!.baseUrl).toContain("https://www.youtube.com/api/timedtext?v=3wXfppSKkpg&");
    expect(tracks[1]).toMatchObject({ languageCode: "de", vssId: ".de", name: "German" });
  });

  it("extractJsonObject respects braces inside strings and escapes", () => {
    const src = 'x = {"a":"}","b":{"c":"\\"}"},"d":[1,{"e":2}]}; rest';
    expect(extractJsonObject(src, 4)).toBe('{"a":"}","b":{"c":"\\"}"},"d":[1,{"e":2}]}');
    expect(extractJsonObject(src, 0)).toBeNull();
    expect(extractJsonObject("{ unterminated", 0)).toBeNull();
  });

  it("returns null/empty for pages without a player response", () => {
    expect(extractPlayerResponse("<html></html>")).toBeNull();
    expect(captionTracksOf(null)).toEqual([]);
    expect(captionTracksOf(extractPlayerResponse('var ytInitialPlayerResponse = {"playabilityStatus":{"status":"ERROR"}};'))).toEqual([]);
  });
});

describe("selectCaptionTrack", () => {
  const tracks: CaptionTrack[] = [
    { baseUrl: "u1", languageCode: "en", kind: "asr", vssId: "a.en" },
    { baseUrl: "u2", languageCode: "en", vssId: ".en" },
    { baseUrl: "u3", languageCode: "en-GB", vssId: ".en-GB" },
    { baseUrl: "u4", languageCode: "de", vssId: ".de" },
  ];
  it("prefers manual exact match, then ASR, then regional variants", () => {
    expect(selectCaptionTrack(tracks, "en")?.baseUrl).toBe("u2");
    expect(selectCaptionTrack(tracks, "en", false)?.baseUrl).toBe("u1");
    expect(selectCaptionTrack(tracks.filter((t) => t.languageCode !== "en"), "en")?.baseUrl).toBe("u3");
    expect(selectCaptionTrack(tracks, "de")?.baseUrl).toBe("u4");
    expect(selectCaptionTrack(tracks, "fr")).toBeNull();
    expect(selectCaptionTrack([], "en")).toBeNull();
  });
});

describe("timedtext parsing", () => {
  it("parses json3, skipping window events and newline appends", () => {
    const segs = parseJson3(JSON3);
    expect(segs).toHaveLength(5);
    expect(segs[0]).toEqual({ start: 0.48, duration: 4.56, text: "hello and welcome to today's bitcoin update" });
    expect(segs[1]!.text).toBe("the key level to watch today is 79k");
    expect(segs[4]!.text).toBe("the invalidation is at $74,800 &amp; that&#39;s it");
  });
  it("parses legacy transcript XML and srv3", () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.48" dur="4.56">hello &amp; welcome</text><text start="5.04" dur="5.28"><font color="#CCCCCC">79k</font> is key</text><text start="9">  </text></transcript>`;
    expect(parseTimedTextXml(xml)).toEqual([
      { start: 0.48, duration: 4.56, text: "hello &amp; welcome" },
      { start: 5.04, duration: 5.28, text: "79k is key" },
    ]);
    const srv3 = `<timedtext format="3"><body><p t="480" d="4560"><s>hello</s><s> there</s></p></body></timedtext>`;
    expect(parseTimedTextXml(srv3)).toEqual([{ start: 0.48, duration: 4.56, text: "hello there" }]);
    expect(parseTimedText(JSON3)).toHaveLength(5);
    expect(parseTimedText(xml)).toHaveLength(2);
    expect(() => parseTimedText("garbage")).toThrow();
  });
});

describe("detectBlock", () => {
  it("recognises the real reCAPTCHA page, 429s, consent walls and bot-check text", () => {
    expect(detectBlock(200, BLOCKED)).toBe("recaptcha");
    expect(detectBlock(429, "")).toBe("http-429");
    expect(detectBlock(200, '<a href="https://consent.youtube.com/m?continue=">')).toBe("consent-wall");
    expect(detectBlock(200, "Sign in to confirm you’re not a bot")).toBe("bot-check");
    expect(detectBlock(200, WATCH)).toBeNull();
  });
});

describe("InnertubeProvider", () => {
  it("fetches watch page then json3 captions for the ASR English track", async () => {
    const { fetch, calls } = router({
      "https://www.youtube.com/watch": () => new Response(WATCH, { status: 200 }),
      "https://www.youtube.com/api/timedtext": (u) => {
        expect(u.searchParams.get("fmt")).toBe("json3");
        expect(u.searchParams.get("lang")).toBe("en");
        return new Response(JSON3, { status: 200 });
      },
    });
    const p = new InnertubeProvider({ fetch, clock: { now: () => 42 } });
    const t = await p.fetch("3wXfppSKkpg");
    expect(t).toMatchObject({ videoId: "3wXfppSKkpg", language: "en", source: "innertube", isGenerated: true, fetchedAt: 42 });
    expect(t!.segments).toHaveLength(5);
    expect(t!.text).toContain("the invalidation is at $74,800 & that's it");
    expect(calls[0]!.url).toContain("/watch?v=3wXfppSKkpg");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["cookie"]).toContain("CONSENT=YES");
  });

  it("throws TranscriptBlockedError on the reCAPTCHA page (as seen live from this sandbox)", async () => {
    const { fetch } = router({ "https://www.youtube.com/watch": () => new Response(BLOCKED, { status: 429 }) });
    const e = await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(TranscriptBlockedError);
    expect((e as TranscriptBlockedError).reason).toBe("http-429");
    expect((e as TranscriptBlockedError).retryable).toBe(true);
  });

  it("falls back to the player API and classifies LOGIN_REQUIRED bot checks as blocked", async () => {
    const noCaptions = WATCH.replace(/"captions":\{.*?"defaultAudioTrackIndex":0\}\},/, "");
    expect(captionTracksOf(extractPlayerResponse(noCaptions))).toEqual([]);
    const { fetch, calls } = router({
      "https://www.youtube.com/watch": () => new Response(noCaptions, { status: 200 }),
      "https://www.youtube.com/youtubei/v1/player": () => new Response(LOGIN_REQUIRED, { status: 200 }),
    });
    const e = await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(TranscriptBlockedError);
    expect((e as TranscriptBlockedError).reason).toBe("bot-check");
    expect(calls[1]!.url).toContain("/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8");
    const body = JSON.parse(calls[1]!.init.body as string) as { context: { client: { clientName: string } }; videoId: string };
    expect(body.context.client.clientName).toBe("ANDROID");
    expect(body.videoId).toBe("3wXfppSKkpg");
  });

  it("uses captions from the player API when the page has none", async () => {
    const noCaptions = WATCH.replace(/"captions":\{.*?"defaultAudioTrackIndex":0\}\},/, "");
    const player = extractPlayerResponse(WATCH)!;
    const { fetch } = router({
      "https://www.youtube.com/watch": () => new Response(noCaptions, { status: 200 }),
      "https://www.youtube.com/youtubei/v1/player": () => new Response(JSON.stringify(player), { status: 200 }),
      "https://www.youtube.com/api/timedtext": () => new Response(JSON3, { status: 200 }),
    });
    const t = await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg");
    expect(t!.segments).toHaveLength(5);
  });

  it("returns null when the video has no caption tracks or no track in the language", async () => {
    const noCaptions = WATCH.replace(/"captions":\{.*?"defaultAudioTrackIndex":0\}\},/, "");
    const { fetch } = router({
      "https://www.youtube.com/watch": () => new Response(noCaptions, { status: 200 }),
      "https://www.youtube.com/youtubei/v1/player": () => new Response(JSON.stringify({ playabilityStatus: { status: "OK" } }), { status: 200 }),
    });
    expect(await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg")).toBeNull();

    const { fetch: f2 } = router({ "https://www.youtube.com/watch": () => new Response(WATCH, { status: 200 }) });
    expect(await new InnertubeProvider({ fetch: f2 }).fetch("3wXfppSKkpg", "fr")).toBeNull();
  });

  it("empty timedtext body means captions are not ready yet (null), blocked timedtext is blocked", async () => {
    const { fetch } = router({
      "https://www.youtube.com/watch": () => new Response(WATCH, { status: 200 }),
      "https://www.youtube.com/api/timedtext": () => new Response("", { status: 200 }),
    });
    expect(await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg")).toBeNull();
    const { fetch: f2 } = router({
      "https://www.youtube.com/watch": () => new Response(WATCH, { status: 200 }),
      "https://www.youtube.com/api/timedtext": () => new Response(BLOCKED, { status: 429 }),
    });
    await expect(new InnertubeProvider({ fetch: f2 }).fetch("3wXfppSKkpg")).rejects.toBeInstanceOf(TranscriptBlockedError);
  });

  it("network errors and 5xx are retryable TranscriptErrors; missing player response is an error", async () => {
    const p = new InnertubeProvider({
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    const e = (await p.fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e).toBeInstanceOf(TranscriptError);
    expect(e.retryable).toBe(true);

    const { fetch } = router({ "https://www.youtube.com/watch": () => new Response("<html>no player here</html>", { status: 200 }) });
    const e2 = (await new InnertubeProvider({ fetch }).fetch("3wXfppSKkpg").catch((e: unknown) => e)) as TranscriptError;
    expect(e2.message).toMatch(/ytInitialPlayerResponse/);
  });
});

/**
 * Live probe. Run with TRANSCRIPT_LIVE_TESTS=1. From datacenter IPs this is expected to end in
 * TranscriptBlockedError; both outcomes pass, the outcome is printed for the report.
 */
describe.skipIf(!process.env["TRANSCRIPT_LIVE_TESTS"])("InnertubeProvider (live)", () => {
  it("fetches 3wXfppSKkpg or is blocked", { timeout: 60_000 }, async () => {
    const p = new InnertubeProvider();
    try {
      const t = await p.fetch("3wXfppSKkpg");
      process.stderr.write(`[live] innertube result: ${t ? `${t.segments.length} segments, lang=${t.language}` : "null (no captions)"}\n`);
      if (t) expect(t.segments.length).toBeGreaterThan(10);
    } catch (err) {
      process.stderr.write(`[live] innertube blocked: ${(err as Error).message}\n`);
      expect(err).toBeInstanceOf(TranscriptBlockedError);
    }
  });
});
