import { decodeEntities, type Transcript, type TranscriptSegment } from "./types.js";

/**
 * Text normalisation for LLM consumption. Purely lexical: it never adds content.
 * Input is untrusted; output is still untrusted and must be delimited as data by the caller.
 */

/** Non-speech annotations produced by ASR and manual captioners. */
const TAG_RE =
  /\[\s*(music|applause|laughter|laughs|inaudible|crosstalk|silence|noise|foreign|__)\s*\]|\((music|applause|laughter|inaudible)\)/gi;

const TICKER_RE = /\b(btc|eth|sol|xrp|ada|bnb|doge|ltc|avax|matic|dot|link|hype|sui|usd|usdt|usdc)\b/gi;
const PROPER_RE = /\b(bitcoin|ethereum|solana|elliott|fibonacci)\b/gi;
const PROPER_CASE: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
  elliott: "Elliott",
  fibonacci: "Fibonacci",
};

/** Normalise a raw caption string: decode entities, strip tags, fix tickers, collapse whitespace. */
export function cleanText(text: string): string {
  return (
    decodeEntities(text)
      .replace(/<[^>]*>/g, " ")
      .replace(TAG_RE, " ")
      .replace(/[\u200B\uFEFF]/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(TICKER_RE, (m) => m.toUpperCase())
      .replace(PROPER_RE, (m) => PROPER_CASE[m.toLowerCase()] ?? m)
      // "79 k" / "79k" -> "79K"; "79 000" -> "79,000"
      .replace(/\b(\d{2,3})\s?k\b/gi, "$1K")
      .replace(/\b(\d{2,3})\s(\d{3})\b/g, "$1,$2")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function cleanSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((s) => ({ ...s, text: cleanText(s.text) })).filter((s) => s.text.length > 0);
}

/** Return a copy of the transcript with cleaned segments and re-joined text. */
export function cleanTranscript(t: Transcript): Transcript {
  const segments = cleanSegments(t.segments);
  return {
    ...t,
    segments,
    text: segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/** Price-like tokens: $79,500  79k  79K  110,000  $2,750. Bare numbers need a $ prefix, a k suffix or a thousands group to count. */
export const PRICE_RE = /\$\s?\d{1,3}(?:,\d{3})*k?\b|\b\d{2,3}(?:,\d{3})?k\b|\b\d{2,3},\d{3}\b/gi;
/** Vocabulary of level talk in Elliott Wave commentary. */
export const LEVEL_WORD_RE =
  /\b(invalidat(?:ion|e[sd]?|ing)|support|resistance|target(?:s|ed)?|wave|breakout|breakdown|retrace(?:ment)?|fib(?:onacci|s)?|pullback|correction|impulse|triangle|diagonal)\b/gi;

export interface KeywordWindow {
  /** Seconds into the video. */
  start: number;
  end: number;
  text: string;
  /** Distinct matched tokens (prices and level words), lower-cased. */
  matches: string[];
  /** Number of matching segments merged into this window. */
  hits: number;
}

export interface WindowOptions {
  /** Segments of context before/after each hit. Default 2 / 2. */
  before?: number;
  after?: number;
  /** Cap on windows returned (highest `hits` first, then chronological). Default 40. */
  maxWindows?: number;
  /** Require both a price token and a level word in the same segment for it to count as a hit. Default false (either). */
  requireBoth?: boolean;
  /** Extra patterns to treat as hits. */
  extra?: RegExp[];
}

function matchesIn(text: string, res: RegExp[]): string[] {
  const out = new Set<string>();
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) out.add(m[0].toLowerCase().replace(/\s+/g, ""));
  }
  return Array.from(out);
}

/**
 * Extract compact passages around segments that mention price levels or level vocabulary.
 * Overlapping windows are merged. Works on segments; a transcript with a single segment (plain text)
 * is first split into sentence-sized pseudo-segments.
 */
export function windowByKeyword(
  input: Transcript | readonly TranscriptSegment[],
  opts: WindowOptions = {},
): KeywordWindow[] {
  const before = opts.before ?? 2;
  const after = opts.after ?? 2;
  const maxWindows = opts.maxWindows ?? 40;
  let segments: readonly TranscriptSegment[] = Array.isArray(input) ? input : (input as Transcript).segments;
  if (segments.length <= 1)
    segments = splitSentences(segments[0]?.text ?? (Array.isArray(input) ? "" : (input as Transcript).text));

  const priceRes = [PRICE_RE];
  const wordRes = [LEVEL_WORD_RE, ...(opts.extra ?? [])];
  const hitIdx: number[] = [];
  const hitMatches = new Map<number, string[]>();
  segments.forEach((s, i) => {
    const prices = matchesIn(s.text, priceRes);
    const words = matchesIn(s.text, wordRes);
    const hit = opts.requireBoth
      ? prices.length > 0 && words.length > 0
      : prices.length > 0 || words.length > 0;
    if (hit) {
      hitIdx.push(i);
      hitMatches.set(i, [...prices, ...words]);
    }
  });
  if (hitIdx.length === 0) return [];

  const windows: { lo: number; hi: number; hits: number; matches: Set<string> }[] = [];
  for (const i of hitIdx) {
    const lo = Math.max(0, i - before);
    const hi = Math.min(segments.length - 1, i + after);
    const last = windows[windows.length - 1];
    if (last && lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, hi);
      last.hits++;
      for (const m of hitMatches.get(i) ?? []) last.matches.add(m);
    } else {
      windows.push({ lo, hi, hits: 1, matches: new Set(hitMatches.get(i) ?? []) });
    }
  }

  const ranked = windows
    .map((w, order) => ({ w, order }))
    .sort((a, b) => b.w.hits - a.w.hits || a.order - b.order)
    .slice(0, maxWindows)
    .sort((a, b) => a.order - b.order);

  return ranked.map(({ w }) => {
    const slice = segments.slice(w.lo, w.hi + 1);
    const lastSeg = slice[slice.length - 1] ?? slice[0];
    return {
      start: slice[0]?.start ?? 0,
      end: lastSeg ? lastSeg.start + lastSeg.duration : 0,
      text: slice
        .map((s) => s.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      matches: Array.from(w.matches),
      hits: w.hits,
    };
  });
}

/** Split plain text into sentence-ish pseudo-segments with zero timing. */
export function splitSentences(text: string): TranscriptSegment[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ start: 0, duration: 0, text: s }));
}
