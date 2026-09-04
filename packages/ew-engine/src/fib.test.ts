import { describe, expect, it } from "vitest";
import {
  bandScore,
  extensionLevel,
  extensionZone,
  retraceLevel,
  retraceRatio,
  retraceZone,
  scoreCorrectionGuidelines,
  scoreImpulseGuidelines,
  waveLengths,
} from "./fib.js";

describe("fib helpers", () => {
  it("computes retrace ratios and levels in both directions", () => {
    expect(retraceRatio(100, 110, 105)).toBeCloseTo(0.5);
    expect(retraceRatio(110, 100, 106.18)).toBeCloseTo(0.618);
    expect(retraceRatio(100, 100, 100)).toBe(0);
    expect(retraceLevel(100, 110, 0.618)).toBeCloseTo(103.82);
    expect(retraceLevel(110, 100, 0.5)).toBeCloseTo(105);
    expect(extensionLevel(100, 10, 1.618, 1)).toBeCloseTo(116.18);
    expect(extensionLevel(100, 10, 1.618, -1)).toBeCloseTo(83.82);
  });
  it("builds ordered zones", () => {
    const z = retraceZone(100, 110, 0.618, 0.5, "w2");
    expect(z.low).toBeCloseTo(103.82);
    expect(z.high).toBeCloseTo(105);
    const e = extensionZone(100, 10, 1, 1.618, -1, "c");
    expect(e.low).toBeCloseTo(83.82);
    expect(e.high).toBeCloseTo(90);
    expect(waveLengths([100, 110, 103.82, 120])).toEqual([10, expect.closeTo(6.18, 9), expect.closeTo(16.18, 9)]);
  });
});

describe("bandScore", () => {
  it("is 1 inside the ideal band, 0.5 at the acceptable edges and monotone beyond", () => {
    expect(bandScore(0.55, 0.5, 0.618, 0.382, 0.786)).toBe(1);
    expect(bandScore(0.382, 0.5, 0.618, 0.382, 0.786)).toBeCloseTo(0.5);
    expect(bandScore(0.786, 0.5, 0.618, 0.382, 0.786)).toBeCloseTo(0.5);
    let prev = 1;
    for (let x = 0.618; x <= 1.6; x += 0.01) {
      const s = bandScore(x, 0.5, 0.618, 0.382, 0.786);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    prev = 1;
    for (let x = 0.5; x >= -0.5; x -= 0.01) {
      const s = bandScore(x, 0.5, 0.618, 0.382, 0.786);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(bandScore(NaN, 0, 1, 0, 1)).toBe(0);
  });
});

describe("scoreImpulseGuidelines", () => {
  const textbook = [100, 110, 103.82, 120, 113.82, 123.82];

  it("scores a textbook impulse near 1 with a note per guideline", () => {
    const s = scoreImpulseGuidelines(textbook, [20, 20, 20, 20, 20]);
    expect(s.score).toBeGreaterThan(0.9);
    expect(s.results.map((r) => r.name)).toEqual([
      "W2 retrace",
      "W3 extension",
      "W4 retrace",
      "W5 length",
      "Alternation",
      "Extension",
    ]);
    expect(s.notes).toHaveLength(6);
  });

  it("is monotone non-increasing as W2 retraces deeper than 61.8%", () => {
    let prev = Infinity;
    for (let r = 0.618; r <= 1.0; r += 0.02) {
      const s = scoreImpulseGuidelines([100, 110, 110 - 10 * r]).score;
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(scoreImpulseGuidelines([100, 110, 104.5]).score).toBe(1);
    expect(scoreImpulseGuidelines([100, 110, 100.5]).score).toBeLessThan(0.5);
  });

  it("is monotone non-decreasing as W3 extends from 0.5× to 1.618× W1", () => {
    let prev = -Infinity;
    for (let x = 0.5; x <= 1.618; x += 0.05) {
      const s = scoreImpulseGuidelines([100, 110, 104.5, 104.5 + 10 * x]).score;
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
  });

  it("rewards alternation and extension", () => {
    const alternating = scoreImpulseGuidelines([100, 110, 103.82, 120, 116.5, 126.5]); // W2 62%, W4 22%
    const same = scoreImpulseGuidelines([100, 110, 106, 120, 116, 126]); // W2 40%, W4 40%
    const altA = alternating.results.find((r) => r.name === "Alternation");
    const altB = same.results.find((r) => r.name === "Alternation");
    expect(altA?.score ?? 0).toBeGreaterThan(altB?.score ?? 1);
    const ext = scoreImpulseGuidelines([100, 110, 105, 115, 111, 121]).results.find((r) => r.name === "Extension");
    expect(ext?.score).toBe(0); // 10, 10, 10 → nothing extended
    const ext2 = scoreImpulseGuidelines(textbook).results.find((r) => r.name === "Extension");
    expect(ext2?.score).toBe(1);
  });

  it("returns a neutral 0.5 when nothing is evaluable", () => {
    const s = scoreImpulseGuidelines([100, 110]);
    expect(s.score).toBe(0.5);
    expect(s.results).toHaveLength(0);
    expect(s.notes[0]).toContain("no guideline");
  });
});

describe("scoreCorrectionGuidelines", () => {
  it("prefers a 50–61.8% B in zigzags and a ~100% B in flats", () => {
    expect(scoreCorrectionGuidelines([120, 100, 111.5], "zigzag").score).toBe(1);
    expect(scoreCorrectionGuidelines([120, 100, 119.5], "flat").score).toBe(1);
    expect(scoreCorrectionGuidelines([120, 100, 119.5], "zigzag").score).toBeLessThan(0.5);
  });
  it("scores C in the 1.0–1.618×A cluster", () => {
    const good = scoreCorrectionGuidelines([120, 100, 112, 92], "zigzag"); // C = 20 = 1.0×A
    const short = scoreCorrectionGuidelines([120, 100, 112, 106], "zigzag"); // C = 6 = 0.3×A
    expect(good.score).toBeGreaterThan(short.score);
    expect(good.results.find((r) => r.name === "C length")?.score).toBe(1);
  });
});
