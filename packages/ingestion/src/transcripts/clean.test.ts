import { describe, expect, it } from "vitest";
import {
  cleanText,
  cleanTranscript,
  LEVEL_WORD_RE,
  PRICE_RE,
  splitSentences,
  windowByKeyword,
} from "./clean.js";
import { buildTranscript, type TranscriptSegment } from "./types.js";

describe("cleanText", () => {
  it("strips tags, decodes entities, fixes tickers and numbers, collapses whitespace", () => {
    expect(cleanText("[Music]  so btc is at 79 k right now &amp; eth at 110 000 , okay")).toBe(
      "so BTC is at 79K right now & ETH at 110,000, okay",
    );
    expect(cleanText("the bitcoin elliott wave count [Applause] (music) is  valid")).toBe(
      "the Bitcoin Elliott wave count is valid",
    );
    expect(cleanText('<font color="#CCCCCC">79k</font> it&#39;s “key”')).toBe('79K it\'s "key"');
    expect(cleanText("[__] [inaudible]")).toBe("");
  });
  it("does not touch ordinary words that merely contain tickers", () => {
    expect(cleanText("both bethany and solar")).toBe("both bethany and solar");
    expect(cleanText("we sol the position")).toBe("we SOL the position");
  });
});

describe("cleanTranscript", () => {
  it("cleans segments, drops empties and re-joins text", () => {
    const t = buildTranscript({
      videoId: "3wXfppSKkpg",
      language: "en",
      source: "test",
      fetchedAt: 0,
      segments: [
        { start: 0, duration: 1, text: "[Music]" },
        { start: 1, duration: 1, text: "btc holds 79 k" },
        { start: 2, duration: 1, text: "invalidation at $74,800" },
      ],
    });
    const c = cleanTranscript(t);
    expect(c.segments.map((s) => s.text)).toEqual(["BTC holds 79K", "invalidation at $74,800"]);
    expect(c.text).toBe("BTC holds 79K invalidation at $74,800");
    expect(t.segments).toHaveLength(3); // input untouched
  });
});

describe("regexes", () => {
  const all = (re: RegExp, s: string) => Array.from(s.matchAll(new RegExp(re.source, re.flags)), (m) => m[0]);
  it("PRICE_RE matches level formats and ignores years, counts and percentages", () => {
    expect(all(PRICE_RE, "$79,500 then 79k or 79K and 110,000 also $2,750 and $76k")).toEqual([
      "$79,500",
      "79k",
      "79K",
      "110,000",
      "$2,750",
      "$76k",
    ]);
    expect(all(PRICE_RE, "in 2026 wave 4 of 5 with 100 percent retrace and 61.8")).toEqual([]);
  });
  it("LEVEL_WORD_RE covers Elliott Wave level vocabulary", () => {
    expect(
      all(LEVEL_WORD_RE, "support, resistance, targets, the invalidation, wave, fib retracement").map((m) =>
        m.toLowerCase(),
      ),
    ).toEqual(["support", "resistance", "targets", "invalidation", "wave", "fib", "retracement"]);
  });
});

describe("windowByKeyword", () => {
  const seg = (i: number, text: string): TranscriptSegment => ({ start: i * 5, duration: 5, text });
  const segments: TranscriptSegment[] = [
    seg(0, "hello and welcome to today's Bitcoin update"),
    seg(1, "let's look at the daily chart first"),
    seg(2, "nothing has changed since yesterday"),
    seg(3, "we are still consolidating"),
    seg(4, "the market is quiet"),
    seg(5, "volume is low"),
    seg(6, "as long as we hold support at 76,500"),
    seg(7, "the wave four count is valid"),
    seg(8, "and the invalidation is at $74,800"),
    seg(9, "so that's the setup"),
    seg(10, "thanks for watching"),
    seg(11, "see you tomorrow"),
    seg(12, "bye"),
    seg(13, "and one more thing"),
    seg(14, "80K is the next target"),
    seg(15, "that is all"),
  ];

  it("extracts merged windows around price/level mentions with timestamps", () => {
    const w = windowByKeyword(segments, { before: 1, after: 1 });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ start: 25, end: 50, hits: 3 });
    expect(w[0]!.text).toBe(
      "volume is low as long as we hold support at 76,500 the wave four count is valid and the invalidation is at $74,800 so that's the setup",
    );
    expect(w[0]!.matches).toEqual(
      expect.arrayContaining(["76,500", "support", "wave", "$74,800", "invalidation"]),
    );
    expect(w[1]).toMatchObject({ start: 65, end: 80, hits: 1, matches: ["80k", "target"] });
    // Context-only segments never appear on their own.
    expect(w.map((x) => x.text).join(" ")).not.toContain("daily chart");
  });

  it("requireBoth demands a price and a level word in the same segment", () => {
    const w = windowByKeyword(segments, { before: 0, after: 0, requireBoth: true });
    expect(w.map((x) => x.text)).toEqual([
      "as long as we hold support at 76,500",
      "and the invalidation is at $74,800",
      "80K is the next target",
    ]);
  });

  it("caps windows by hit count, keeps chronological order, returns [] without hits", () => {
    const w = windowByKeyword(segments, { before: 0, after: 0, maxWindows: 1 });
    expect(w).toHaveLength(1);
    expect(w[0]!.hits).toBe(3);
    expect(windowByKeyword([seg(0, "hello"), seg(1, "world")])).toEqual([]);
  });

  it("falls back to sentence splitting for single-segment (plain text) transcripts", () => {
    const t = buildTranscript({
      videoId: "3wXfppSKkpg",
      language: "en",
      source: "supadata",
      fetchedAt: 0,
      segments: [
        {
          start: 0,
          duration: 0,
          text: "Welcome back. Nothing changed overnight. Support sits at 76,500 and invalidation at $74,800. Thanks for watching.",
        },
      ],
    });
    const w = windowByKeyword(t, { before: 0, after: 0 });
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toBe("Support sits at 76,500 and invalidation at $74,800.");
    expect(splitSentences("A. B! C?\nD")).toHaveLength(4);
  });
});
