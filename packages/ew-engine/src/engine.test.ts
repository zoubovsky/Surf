import { describe, expect, it } from "vitest";
import { EwAnalysis } from "@surf/core";
import { analyze, analyzeMulti } from "./engine.js";
import { insideBar, randomWalk, syntheticImpulse } from "./synthetic.js";

const P5 = 100 + 10 * (1 - 0.618 + 1.618 - 0.618 + 1);

describe("analyze", () => {
  it("returns schema-valid output with momentum context", () => {
    const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
    const a = analyze(series.candles);
    expect(EwAnalysis.safeParse(a).success).toBe(true);
    expect(a.symbol).toBe("BTC-USD");
    expect(a.interval).toBe("1h");
    expect(a.asOf).toBe(series.candles[series.candles.length - 1]?.closeTime);
    expect(a.lastClose).toBe(series.candles[series.candles.length - 1]?.close);
    expect(a.swings).toHaveLength(6);
    expect(a.momentum.rsi14).not.toBeNull();
    expect(a.momentum.atr14).not.toBeNull();
    expect(a.momentum.rsiDivergence).toBe("bearish");
  });

  it("throws on empty input only", () => {
    expect(() => analyze([])).toThrow(/at least one candle/);
    const one = analyze(randomWalk(1, { seed: 1 }));
    expect(one.candidates).toEqual([]);
    expect(one.swings).toEqual([]);
    expect(one.momentum.rsi14).toBeNull();
    expect(one.momentum.atr14).toBeNull();
  });

  it("honours topK, ks and swingsK", () => {
    const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
    const a = analyze(series.candles, { topK: 1, ks: [2, 4], swingsK: 4 });
    expect(a.candidates).toHaveLength(1);
    expect(a.candidates[0]?.notes.some((n) => n.includes("k=2, 4"))).toBe(true);
  });

  it("never throws on random walks and always returns schema-valid output (property)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const n = 5 + ((seed * 37) % 600);
      const candles = randomWalk(n, { seed, vol: 0.002 + (seed % 7) * 0.004 });
      const a = analyze(candles);
      const parsed = EwAnalysis.safeParse(a);
      expect(parsed.success, `seed ${seed}: ${JSON.stringify(parsed.error?.issues.slice(0, 2))}`).toBe(true);
      expect(a.candidates.length).toBeLessThanOrEqual(5);
      for (const c of a.candidates) {
        expect(c.hardRulesPassed).toBe(true);
        for (let i = 1; i < c.pivots.length; i++) expect(c.pivots[i]?.kind).not.toBe(c.pivots[i - 1]?.kind);
        for (const t of c.targets) expect(t.low).toBeLessThanOrEqual(t.high);
        if (c.entryZone) expect(c.entryZone.low).toBeLessThanOrEqual(c.entryZone.high);
      }
      const ids = new Set(a.candidates.map((c) => c.id));
      expect(ids.size).toBe(a.candidates.length);
    }
  });

  it("is deterministic", () => {
    const candles = randomWalk(400, { seed: 21 });
    expect(analyze(candles)).toEqual(analyze(candles));
  });

  it("is stable: appending a non-extreme candle does not change candidate ids", () => {
    const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
    const before = analyze(series.candles, { topK: 10 });
    const after = analyze([...series.candles, insideBar(series.candles)], { topK: 10 });
    expect(after.swings).toEqual(before.swings);
    expect(after.candidates.map((c) => c.id).sort()).toEqual(before.candidates.map((c) => c.id).sort());
    for (const c of after.candidates) {
      const prev = before.candidates.find((p) => p.id === c.id);
      expect(prev?.pivots).toEqual(c.pivots);
      expect(prev?.invalidation).toEqual(c.invalidation);
    }
    const walk = randomWalk(500, { seed: 33 });
    const b2 = analyze(walk, { topK: 10 });
    const a2 = analyze([...walk, insideBar(walk)], { topK: 10 });
    expect(a2.candidates.map((c) => c.id).sort()).toEqual(b2.candidates.map((c) => c.id).sort());
  });
});

describe("analyzeMulti", () => {
  const h4 = syntheticImpulse({ legs: 2, partial: 0.9, seed: 3, interval: "4h" }); // top 4h candidate: long
  const h1 = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] }); // top 1h alone: short

  it("boosts agreeing 1h candidates and penalises conflicting ones by the boost amount", () => {
    const solo = analyze(h1.candles, { topK: 15 });
    const multi = analyzeMulti({ h1: h1.candles, h4: h4.candles }, { topK: 15 });
    expect(multi.h4Direction).toBe("long");
    expect(multi.h4.candidates[0]?.direction).toBe("long");
    expect(multi.h1.candidates.length).toBe(solo.candidates.length);
    for (const c of multi.h1.candidates) {
      const base = solo.candidates.find((s) => s.id === c.id);
      expect(base).toBeDefined();
      const expected = c.direction === "long" ? Math.min(1, (base?.score ?? 0) + 0.1) : Math.max(0, (base?.score ?? 0) - 0.1);
      expect(c.score).toBeCloseTo(expected, 4);
      expect(c.notes[c.notes.length - 1]).toContain(c.direction === "long" ? "agrees" : "conflicts");
    }
    expect(EwAnalysis.safeParse(multi.h1).success).toBe(true);
    expect(multi.h4).toEqual(analyze(h4.candles, { topK: 15 }));
  });

  it("re-sorts and truncates the 1h list after adjustment", () => {
    const solo = analyze(h1.candles, { topK: 2 });
    expect(solo.candidates[0]?.direction).toBe("short");
    const multi = analyzeMulti({ h1: h1.candles, h4: h4.candles }, { topK: 2, boost: 0.5 });
    expect(multi.h1.candidates).toHaveLength(2);
    expect(multi.h1.candidates[0]?.direction).toBe("long");
    for (let i = 1; i < multi.h1.candidates.length; i++) {
      expect(multi.h1.candidates[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(multi.h1.candidates[i]?.score ?? 0);
    }
  });

  it("leaves 1h scores untouched when the 4h has no candidates", () => {
    const flat4h = randomWalk(3, { seed: 2, interval: "4h" });
    const solo = analyze(h1.candles);
    const multi = analyzeMulti({ h1: h1.candles, h4: flat4h });
    expect(multi.h4Direction).toBeNull();
    expect(multi.h1.candidates).toEqual(solo.candidates);
  });
});
