/** One caption cue. `start` and `duration` are in seconds. Text is untrusted data. */
export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

export interface Transcript {
  videoId: string;
  /** BCP-47/ISO 639-1 code as reported by the source, e.g. "en". */
  language: string;
  /** Provider name that produced it ("supadata", "innertube", "yt-dlp"). */
  source: string;
  segments: TranscriptSegment[];
  /** Segments joined with single spaces, entities decoded, whitespace collapsed. See `cleanTranscript` for more. */
  text: string;
  /** Unix ms. */
  fetchedAt: number;
  /** True when the track is known to be auto-generated (ASR). Undefined when the source does not say. */
  isGenerated?: boolean;
}

export interface TranscriptProvider {
  readonly name: string;
  /**
   * Resolve a transcript. Return `null` when no transcript is available for this video right now
   * (no captions, video private/removed). Throw a `TranscriptError` subclass for failures that
   * are about the provider rather than the video (blocked, unauthorized, rate limited, server error).
   */
  fetch(videoId: string, lang?: string): Promise<Transcript | null>;
}

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function assertVideoId(videoId: string): void {
  if (!VIDEO_ID_RE.test(videoId)) throw new TypeError(`invalid YouTube video id: ${JSON.stringify(videoId)}`);
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the handful of HTML entities YouTube captions and Atom feeds use. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[body.toLowerCase()] ?? m;
  });
}

export function joinSegments(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BuildTranscriptInput {
  videoId: string;
  language: string;
  source: string;
  segments: TranscriptSegment[];
  fetchedAt: number;
  isGenerated?: boolean;
}

/** Normalise segments (decode entities, drop empties, sort by start) and derive `text`. */
export function buildTranscript(input: BuildTranscriptInput): Transcript {
  const segments = input.segments
    .map((s) => ({ start: s.start, duration: s.duration, text: decodeEntities(s.text).replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text.length > 0 && Number.isFinite(s.start) && s.start >= 0)
    .sort((a, b) => a.start - b.start);
  const t: Transcript = {
    videoId: input.videoId,
    language: input.language,
    source: input.source,
    segments,
    text: joinSegments(segments),
    fetchedAt: input.fetchedAt,
  };
  if (input.isGenerated !== undefined) t.isGenerated = input.isGenerated;
  return t;
}
