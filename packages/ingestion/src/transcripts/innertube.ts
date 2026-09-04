import { systemClock, type Clock } from "@surf/core";
import { z } from "zod";
import type { FetchLike } from "../feed.js";
import { TranscriptBlockedError, TranscriptError } from "./errors.js";
import { parseTimedText } from "./timedtext.js";
import { assertVideoId, buildTranscript, type Transcript, type TranscriptProvider } from "./types.js";

/**
 * Direct YouTube caption retrieval, mirroring youtube-transcript-api:
 *  1. GET the watch page (with a consent cookie), extract `INNERTUBE_API_KEY` and `ytInitialPlayerResponse`.
 *  2. If the page has no `captionTracks`, POST /youtubei/v1/player with an ANDROID client context.
 *  3. Pick the requested language (manual track preferred over ASR `a.<lang>`), GET the timedtext URL as json3.
 *
 * Expected to fail from datacenter IPs with a bot check ("Sign in to confirm you're not a bot",
 * reCAPTCHA page, HTTP 429) — surfaced as `TranscriptBlockedError` so the chain can classify it.
 * Verified 2026-09-04 from this sandbox: watch page -> 429 + g-recaptcha; player API -> LOGIN_REQUIRED.
 */

export const WATCH_URL = "https://www.youtube.com/watch";
export const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" };

export interface InnertubeOptions {
  fetch?: FetchLike;
  clock?: Clock;
  userAgent?: string;
  /** Prefer a manually created track over auto-generated when both exist in the language. Default true. */
  preferManual?: boolean;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** "asr" for auto-generated tracks. */
  kind?: string;
  /** e.g. "a.en" for ASR English, ".en" for manual English. */
  vssId?: string;
  name?: string;
}

const RawTrack = z
  .object({
    baseUrl: z.string(),
    languageCode: z.string(),
    kind: z.string().optional(),
    vssId: z.string().optional(),
    name: z.object({ simpleText: z.string().optional(), runs: z.array(z.object({ text: z.string() })).optional() }).passthrough().optional(),
  })
  .passthrough();

const PlayerResponse = z
  .object({
    playabilityStatus: z.object({ status: z.string().optional(), reason: z.string().optional() }).passthrough().optional(),
    captions: z
      .object({ playerCaptionsTracklistRenderer: z.object({ captionTracks: z.array(z.unknown()).optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type PlayerResponse = z.infer<typeof PlayerResponse>;

/** Extract a balanced JSON object literal starting at `start` (which must point at `{`). */
export function extractJsonObject(src: string, start: number): string | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

export function extractInnertubeApiKey(html: string): string | null {
  const m = /"INNERTUBE_API_KEY"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(html);
  return m?.[1] ?? null;
}

export function extractPlayerResponse(html: string): PlayerResponse | null {
  const m = /ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!m) return null;
  const json = extractJsonObject(html, m.index + m[0].length);
  if (!json) return null;
  try {
    const parsed = PlayerResponse.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function captionTracksOf(player: PlayerResponse | null): CaptionTrack[] {
  const raw = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const out: CaptionTrack[] = [];
  for (const r of raw) {
    const t = RawTrack.safeParse(r);
    if (!t.success) continue;
    const track: CaptionTrack = { baseUrl: t.data.baseUrl, languageCode: t.data.languageCode };
    if (t.data.kind !== undefined) track.kind = t.data.kind;
    if (t.data.vssId !== undefined) track.vssId = t.data.vssId;
    const name = t.data.name;
    if (name) {
      const label = name.simpleText ?? name.runs?.map((r) => r.text).join("");
      if (label) track.name = label;
    }
    out.push(track);
  }
  return out;
}

export function isGeneratedTrack(t: CaptionTrack): boolean {
  return t.kind === "asr" || (t.vssId?.startsWith("a.") ?? false);
}

/** Choose a track for `lang`: exact language match, manual preferred, then regional variants (en-US), then nothing. */
export function selectCaptionTrack(tracks: CaptionTrack[], lang = "en", preferManual = true): CaptionTrack | null {
  const want = lang.toLowerCase();
  const rank = (t: CaptionTrack): number => {
    const code = t.languageCode.toLowerCase();
    let score = code === want ? 0 : code.split("-")[0] === want ? 10 : -1;
    if (score < 0) return -1;
    if (isGeneratedTrack(t) === preferManual) score += 1;
    return score;
  };
  let best: CaptionTrack | null = null;
  let bestScore = Infinity;
  for (const t of tracks) {
    const s = rank(t);
    if (s >= 0 && s < bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

const BLOCK_MARKERS: [RegExp, string][] = [
  [/class="g-recaptcha"/, "recaptcha"],
  [/www\.google\.com\/sorry\//, "sorry-page"],
  [/consent\.youtube\.com/, "consent-wall"],
  [/Sign in to confirm you(?:'|’|&#39;)re not a bot/i, "bot-check"],
];

/** Detect a bot-check/consent page in a watch-page response. Returns the reason or null. */
export function detectBlock(status: number, html: string): string | null {
  if (status === 429) return "http-429";
  for (const [re, reason] of BLOCK_MARKERS) if (re.test(html)) return reason;
  return null;
}

export class InnertubeProvider implements TranscriptProvider {
  readonly name = "innertube";
  private readonly http: FetchLike;
  private readonly clock: Clock;
  private readonly userAgent: string;
  private readonly preferManual: boolean;

  constructor(opts: InnertubeOptions = {}) {
    this.http = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clock = opts.clock ?? systemClock;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.preferManual = opts.preferManual ?? true;
  }

  async fetch(videoId: string, lang = "en"): Promise<Transcript | null> {
    assertVideoId(videoId);
    const html = await this.getWatchPage(videoId);
    let player = extractPlayerResponse(html);
    let tracks = captionTracksOf(player);
    if (tracks.length === 0) {
      const apiKey = extractInnertubeApiKey(html);
      if (apiKey) {
        player = await this.getPlayerResponse(apiKey, videoId);
        tracks = captionTracksOf(player);
      }
    }
    const status = player?.playabilityStatus?.status;
    const reason = player?.playabilityStatus?.reason ?? "";
    if (status === "LOGIN_REQUIRED" && /bot/i.test(reason)) throw new TranscriptBlockedError(this.name, "bot-check");
    if (tracks.length === 0) {
      if (!player) throw new TranscriptError("innertube: could not find ytInitialPlayerResponse", { provider: this.name, retryable: true });
      return null; // no captions, or video private/removed/age-gated
    }
    const track = selectCaptionTrack(tracks, lang, this.preferManual);
    if (!track) return null;

    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    const res = await this.get(url.toString(), { accept: "*/*" });
    const body = await res.text();
    if (res.status === 429 || detectBlock(res.status, body)) throw new TranscriptBlockedError(this.name, "timedtext-blocked", { status: res.status });
    if (!res.ok) throw new TranscriptError(`innertube: timedtext HTTP ${res.status}`, { provider: this.name, retryable: res.status >= 500, status: res.status });
    if (!body.trim()) return null; // YouTube returns an empty body when the track is not ready yet
    const segments = parseTimedText(body);
    if (segments.length === 0) return null;
    return buildTranscript({ videoId, language: track.languageCode, source: this.name, segments, fetchedAt: this.clock.now(), isGenerated: isGeneratedTrack(track) });
  }

  private async getWatchPage(videoId: string): Promise<string> {
    const url = `${WATCH_URL}?v=${encodeURIComponent(videoId)}&hl=en&bpctr=9999999999&has_verified=1`;
    const res = await this.get(url, { accept: "text/html", cookie: "CONSENT=YES+cb; SOCS=CAI" });
    const html = await res.text();
    const blocked = detectBlock(res.status, html);
    if (blocked) throw new TranscriptBlockedError(this.name, blocked, { status: res.status });
    if (!res.ok) throw new TranscriptError(`innertube: watch page HTTP ${res.status}`, { provider: this.name, retryable: res.status >= 500, status: res.status });
    return html;
  }

  private async getPlayerResponse(apiKey: string, videoId: string): Promise<PlayerResponse | null> {
    const url = `${INNERTUBE_PLAYER_URL}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
    const res = await this.http(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", "accept-language": "en-US" },
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId, contentCheckOk: true, racyCheckOk: true }),
    });
    const text = await res.text();
    if (res.status === 429) throw new TranscriptBlockedError(this.name, "http-429", { status: 429 });
    if (!res.ok) throw new TranscriptError(`innertube: player API HTTP ${res.status}`, { provider: this.name, retryable: res.status >= 500, status: res.status });
    try {
      const parsed = PlayerResponse.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async get(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.http(url, { method: "GET", headers: { "user-agent": this.userAgent, "accept-language": "en-US,en;q=0.9", ...headers }, redirect: "follow" });
    } catch (err) {
      throw new TranscriptError(`innertube: network error: ${(err as Error).message}`, { provider: this.name, retryable: true, cause: err });
    }
  }
}
