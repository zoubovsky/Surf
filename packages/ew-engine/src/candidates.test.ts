import { describe, expect, it } from "vitest";
import { EwCandidate } from "@surf/core";
import type { Swing } from "@surf/core";
import {
  buildImpulseCandidate,
  dedupeCandidates,
  enumerateCandidates,
  scoreCandidate,
} from "./candidates.js";
import type { CandidateContext, RawCandidate } from "./candidates.js";
import { analyze } from "./engine.js";
import { retraceLevel } from "./fib.js";
import { candlesFromPath, syntheticImpulse } from "./synthetic.js";
import { zigzagDetailed } from "./zigzag.js";

const P5 = 100 + 10 * (1 - 0.618 + 1.618 - 0.618 + 1); // 123.82

describe("impulse in wave 2", () => {
  const series = syntheticImpulse({ legs: 2, partial: 0.9, seed: 3 });
  const a = analyze(series.candles);

  it("yields a long in-wave-2 candidate with invalidation at the W1 origin", () => {
    const c = a.candidates.find((x) => x.position === "in-wave-2");
    expect(c).toBeDefined();
    expect(c?.direction).toBe("long");
    expect(c?.pattern).toBe("impulse");
    expect(c?.pivots).toHaveLength(2);
    expect(c?.invalidation.price).toBeCloseTo(series.pivotPrices[0] ?? NaN, 6);
    expect(c?.invalidation.label).toContain("W1 origin");
    expect(c?.hardRulesPassed).toBe(true);
    expect(a.candidates[0]?.id).toBe(c?.id);
  });

  it("puts the entry zone in the 50–61.8% retrace band of W1", () => {
    const c = a.candidates.find((x) => x.position === "in-wave-2");
    const p0 = series.pivotPrices[0] ?? NaN;
    const p1 = series.pivotPrices[1] ?? NaN;
    expect(c?.entryZone).not.toBeNull();
    expect(c?.entryZone?.low).toBeCloseTo(retraceLevel(p0, p1, 0.618), 6);
    expect(c?.entryZone?.high).toBeCloseTo(retraceLevel(p0, p1, 0.5), 6);
    expect(c?.targets[0]?.low ?? 0).toBeGreaterThan(p1);
  });

  it("uses the stable id format and agrees across degrees", () => {
    const c = a.candidates[0];
    expect(c?.id).toBe(`1h-impulse-${c?.pivots[0]?.time}-${c?.pivots[1]?.time}`);
    expect(c?.notes.some((n) => n.includes("k=1.5, 3, 6"))).toBe(true);
  });

  it("mirrors to a short candidate for a down impulse", () => {
    const down = syntheticImpulse({ legs: 2, partial: 0.9, seed: 3, dir: -1 });
    const c = analyze(down.candles).candidates.find((x) => x.position === "in-wave-2");
    expect(c?.direction).toBe("short");
    expect(c?.invalidation.price).toBeCloseTo(down.pivotPrices[0] ?? NaN, 6);
    expect(c?.entryZone?.low ?? 0).toBeLessThan(c?.entryZone?.high ?? 0);
    expect(c?.targets[0]?.high ?? Infinity).toBeLessThan(down.pivotPrices[1] ?? 0);
  });
});

describe("impulse in wave 4", () => {
  const series = syntheticImpulse({ legs: 4, partial: 0.6, seed: 4 });
  const a = analyze(series.candles);
  it("yields a long in-wave-4 candidate invalidated at the W1 extreme with a 23.6–38.2% entry zone", () => {
    const c = a.candidates.find((x) => x.position === "in-wave-4" && x.pattern === "impulse");
    expect(c).toBeDefined();
    expect(c?.direction).toBe("long");
    expect(c?.invalidation.price).toBeCloseTo(series.pivotPrices[1] ?? NaN, 6);
    const p2 = series.pivotPrices[2] ?? NaN;
    const p3 = series.pivotPrices[3] ?? NaN;
    expect(c?.entryZone?.low).toBeCloseTo(retraceLevel(p2, p3, 0.382), 6);
    expect(c?.entryZone?.high).toBeCloseTo(retraceLevel(p2, p3, 0.236), 6);
    expect(c?.notes.some((n) => n.includes("W3 ended at an RSI extreme"))).toBe(true);
  });
});

describe("complete impulse", () => {
  const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
  const a = analyze(series.candles);

  it("yields a short-biased complete candidate at the top, invalidated at the W5 extreme", () => {
    const c = a.candidates[0];
    expect(c?.position).toBe("complete");
    expect(c?.pattern).toBe("impulse");
    expect(c?.direction).toBe("short");
    expect(c?.pivots).toHaveLength(6);
    expect(c?.invalidation.price).toBeCloseTo(series.pivotPrices[5] ?? NaN, 6);
    expect(c?.entryZone).toBeNull();
    expect(c?.targets.length).toBeGreaterThan(0);
    expect(c?.notes.some((n) => n.includes("bearish RSI divergence"))).toBe(true);
  });

  it("scores the reversal call below what the same structure would score as a continuation", () => {
    const c = a.candidates[0];
    expect(c?.score ?? 0).toBeLessThan(0.9);
    expect(c?.score ?? 0).toBeGreaterThan(0.6);
  });

  it("discounts a complete structure whose first target is already reached", () => {
    const deep = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 12, bars: 12 }] });
    const c = analyze(deep.candles).candidates.find(
      (x) => x.position === "complete" && x.pattern === "impulse",
    );
    expect(c?.notes.some((n) => n.includes("already reached"))).toBe(true);
    expect(c?.score ?? 1).toBeLessThan(a.candidates[0]?.score ?? 0);
  });
});

describe("diagonals", () => {
  // W: 10, 6, 8, 4, 5 → W4 (108) overlaps W1 end (110); contracting wedge.
  const legs = [110, 104, 112, 108, 113].map((price) => ({ price, bars: 20 }));

  it("emits a complete contracting diagonal where an impulse is invalid by overlap", () => {
    const series = candlesFromPath(100, [...legs, { price: 109, bars: 15 }], { seed: 6 });
    const a = analyze(series.candles);
    const d = a.candidates.find((c) => c.pivots.length === 6);
    expect(d?.pattern).toBe("diagonal");
    expect(d?.position).toBe("complete");
    expect(d?.direction).toBe("short");
    expect(d?.notes.some((n) => n.includes("overlap permitted"))).toBe(true);
    expect(a.candidates.some((c) => c.pattern === "impulse" && c.pivots.length === 6)).toBe(false);
  });

  it("emits an in-progress in-wave-4 diagonal invalidated at the W2 extreme once W4 overlaps W1", () => {
    const series = candlesFromPath(100, [...legs.slice(0, 3), { price: 108, bars: 12 }], { seed: 6 });
    const a = analyze(series.candles);
    const d = a.candidates.find((c) => c.position === "in-wave-4");
    expect(d?.pattern).toBe("diagonal");
    expect(d?.direction).toBe("long");
    expect(d?.invalidation.price).toBeCloseTo(series.pivotPrices[2] ?? NaN, 6);
  });

  it("rejects overlap without a wedge shape", () => {
    // W: 10, 6, 21, 17, 10 → overlap (108 < 110), W3 > W1 (not contracting), W5 < W3 (not expanding).
    const bad = [110, 104, 125, 108, 118].map((price) => ({ price, bars: 20 }));
    const series = candlesFromPath(100, [...bad, { price: 114, bars: 15 }], { seed: 6 });
    const a = analyze(series.candles);
    expect(a.candidates.some((c) => c.pivots.length === 6)).toBe(false);
  });
});

describe("corrections", () => {
  it("finds an in-wave-c long candidate after a complete up impulse", () => {
    const wA = 6;
    const A = P5 - wA;
    const B = A + 0.618 * wA;
    const series = syntheticImpulse({
      seed: 8,
      tail: [
        { price: A, bars: 15 },
        { price: B, bars: 10 },
        { price: B - 0.7 * wA, bars: 8 },
      ],
    });
    const a = analyze(series.candles, { topK: 10 });
    const c = a.candidates.find((x) => x.position === "in-wave-c");
    expect(c).toBeDefined();
    expect(c?.pattern).toBe("zigzag");
    expect(c?.direction).toBe("long");
    expect(c?.pivots.map((p) => p.kind)).toEqual(["high", "low", "high"]);
    const bPrice = c?.pivots[2]?.price ?? NaN;
    const aLen = Math.abs((c?.pivots[1]?.price ?? NaN) - (c?.pivots[0]?.price ?? NaN));
    expect(c?.entryZone?.high).toBeCloseTo(bPrice - aLen, 4);
    expect(c?.entryZone?.low).toBeCloseTo(bPrice - 1.618 * aLen, 4);
    expect(c?.invalidation.price).toBeCloseTo(bPrice - 1.718 * aLen, 4);
    expect(c?.notes.some((n) => n.includes("corrects a rule-valid 5-wave impulse"))).toBe(true);
    expect(c?.targets[0]?.high).toBeCloseTo(c?.pivots[0]?.price ?? NaN, 6);
  });

  it("classifies a deep B as a flat", () => {
    const wA = 6;
    const A = P5 - wA;
    const B = A + 0.95 * wA;
    const series = syntheticImpulse({
      seed: 8,
      tail: [
        { price: A, bars: 15 },
        { price: B, bars: 10 },
        { price: B - 0.5 * wA, bars: 8 },
      ],
    });
    const c = analyze(series.candles, { topK: 10 }).candidates.find((x) => x.position === "in-wave-c");
    expect(c?.pattern).toBe("flat");
  });

  it("drops the in-wave-c candidate once price is beyond the 1.618×A projection", () => {
    const wA = 6;
    const A = P5 - wA;
    const B = A + 0.618 * wA;
    const series = syntheticImpulse({
      seed: 8,
      tail: [
        { price: A, bars: 15 },
        { price: B, bars: 10 },
        { price: B - 2.0 * wA, bars: 20 },
      ],
    });
    const cands = analyze(series.candles, { topK: 10 }).candidates;
    expect(
      cands.some((x) => x.position === "in-wave-c" && x.pivots[0]?.price === series.pivotPrices[5]),
    ).toBe(false);
  });
});

describe("enumeration mechanics", () => {
  const swing = (index: number, price: number, kind: "high" | "low"): Swing => ({
    index,
    time: index * 3_600_000,
    price,
    kind,
  });
  const ctx: CandidateContext = { interval: "1h", lastClose: 105, rsi: [], intervalMs: 3_600_000 };

  it("builds an in-wave-2 candidate directly from pivots and rejects a W2 beyond origin", () => {
    const ok = buildImpulseCandidate(
      [swing(0, 100, "low"), swing(10, 110, "high")],
      swing(15, 104, "low"),
      ctx,
      3,
    );
    expect(ok?.base.position).toBe("in-wave-2");
    expect(ok?.base.invalidation.price).toBe(100);
    const bad = buildImpulseCandidate(
      [swing(0, 100, "low"), swing(10, 110, "high")],
      swing(15, 99, "low"),
      ctx,
      3,
    );
    expect(bad).toBeNull();
    const notShortest = buildImpulseCandidate(
      [
        swing(0, 100, "low"),
        swing(1, 110, "high"),
        swing(2, 105, "low"),
        swing(3, 113, "high"),
        swing(4, 111, "low"),
        swing(5, 121, "high"),
      ],
      null,
      ctx,
      3,
    );
    expect(notShortest).toBeNull();
  });

  it("merges the same structure seen at several degrees and boosts the score", () => {
    const window = [swing(0, 100, "low"), swing(10, 110, "high")];
    const r1 = buildImpulseCandidate(window, swing(15, 104, "low"), ctx, 1.5) as RawCandidate;
    const r2 = buildImpulseCandidate(window, swing(15, 104, "low"), ctx, 3) as RawCandidate;
    const r3 = buildImpulseCandidate(window, swing(15, 104, "low"), ctx, 6) as RawCandidate;
    const merged = dedupeCandidates([r1, r2, r3], ctx.intervalMs);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.degrees).toEqual([1.5, 3, 6]);
    expect(scoreCandidate(merged[0] as RawCandidate)).toBeCloseTo(scoreCandidate(r1) + 0.1, 4);
  });

  it("merges near-identical pivots (within two bars) but not different structures", () => {
    const r1 = buildImpulseCandidate(
      [swing(0, 100, "low"), swing(10, 110, "high")],
      swing(15, 104, "low"),
      ctx,
      1.5,
    ) as RawCandidate;
    const r2 = buildImpulseCandidate(
      [swing(1, 100.2, "low"), swing(11, 110.1, "high")],
      swing(15, 104, "low"),
      ctx,
      3,
    ) as RawCandidate;
    const r3 = buildImpulseCandidate(
      [swing(4, 100, "low"), swing(10, 110, "high")],
      swing(15, 104, "low"),
      ctx,
      6,
    ) as RawCandidate;
    expect(dedupeCandidates([r1, r2], ctx.intervalMs)).toHaveLength(1);
    expect(dedupeCandidates([r1, r3], ctx.intervalMs)).toHaveLength(2);
  });

  it("returns schema-valid candidates sorted by score and capped at topK", () => {
    const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
    const degrees = [1.5, 3, 6].map((k) => zigzagDetailed(series.candles, { k }));
    const closes = series.candles.map((c) => c.close);
    const list = enumerateCandidates(
      degrees,
      { ...ctx, lastClose: closes[closes.length - 1] ?? 0 },
      { topK: 2 },
    );
    expect(list.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < list.length; i++)
      expect(list[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(list[i]?.score ?? 0);
    for (const c of list) expect(EwCandidate.safeParse(c).success).toBe(true);
  });
});
