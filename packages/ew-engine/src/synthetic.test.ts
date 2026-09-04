import { describe, expect, it } from "vitest";
import { Candle } from "@surf/core";
import {
  candlesFromPath,
  correctionLegs,
  impulseLegs,
  insideBar,
  lcg,
  randomWalk,
  syntheticImpulse,
} from "./synthetic.js";

describe("synthetic", () => {
  it("lcg is deterministic and in [0,1)", () => {
    const a = lcg(42);
    const b = lcg(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("impulse and correction legs follow the requested ratios", () => {
    const legs = impulseLegs(100, 10, { w2: 0.5, w3: 2, w4: 0.25, w5: 1 }, [5, 6, 7, 8, 9]);
    expect(legs.map((l) => l.price)).toEqual([110, 105, 125, 120, 130]);
    expect(legs.map((l) => l.bars)).toEqual([5, 6, 7, 8, 9]);
    const down = impulseLegs(100, 10, {}, 10, -1);
    expect(down[0]?.price).toBe(90);
    expect(down[4]?.price).toBeCloseTo(100 - 23.82);
    const corr = correctionLegs(120, 20, { b: 0.5, c: 1 }, 5, -1);
    expect(corr.map((l) => l.price)).toEqual([100, 110, 90]);
  });

  it("produces valid candles whose pivot bars are strict extremes of their legs", () => {
    const s = syntheticImpulse({ seed: 11, noise: 0.4 });
    expect(s.candles).toHaveLength(100);
    for (const c of s.candles) {
      expect(Candle.safeParse(c).success).toBe(true);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    for (let i = 1; i < s.candles.length; i++) {
      expect(s.candles[i]?.open).toBe(s.candles[i - 1]?.close);
      expect(s.candles[i]?.openTime).toBe((s.candles[i - 1]?.openTime ?? 0) + 3_600_000);
    }
    expect(s.pivotIndices).toEqual([0, 19, 39, 59, 79, 99]);
    expect(s.targets).toEqual([100, 110, 103.82, 120, 113.81924, 123.81924].map((x) => expect.closeTo(x, 9)));
    // Each pivot is the extreme of the two legs around it.
    for (let p = 1; p < s.pivotIndices.length; p++) {
      const idx = s.pivotIndices[p] ?? 0;
      const from = s.pivotIndices[p - 1] ?? 0;
      const to = s.pivotIndices[p + 1] ?? s.candles.length - 1;
      const isHigh = p % 2 === 1;
      for (let i = from; i <= to; i++) {
        if (i === idx) continue;
        const c = s.candles[i];
        if (isHigh) expect(c?.high ?? Infinity).toBeLessThan(s.pivotPrices[p] ?? -Infinity);
        else expect(c?.low ?? -Infinity).toBeGreaterThan(s.pivotPrices[p] ?? Infinity);
      }
    }
  });

  it("supports truncation, tails and zero noise", () => {
    const partial = syntheticImpulse({ legs: 2, partial: 0.5, noise: 0 });
    expect(partial.candles).toHaveLength(30);
    expect(partial.candles[partial.candles.length - 1]?.close).toBeCloseTo(110 - 0.5 * 6.18);
    const withTail = syntheticImpulse({ tail: [{ price: 115, bars: 5 }] });
    expect(withTail.candles).toHaveLength(105);
    expect(withTail.pivotIndices[6]).toBe(104);
    expect(candlesFromPath(100, []).candles).toEqual([]);
  });

  it("random walk stays positive and respects the interval", () => {
    const w = randomWalk(300, { seed: 3, interval: "4h" });
    expect(w).toHaveLength(300);
    for (const c of w) {
      expect(c.low).toBeGreaterThan(0);
      expect(c.interval).toBe("4h");
      expect(c.closeTime - c.openTime).toBe(14_400_000 - 1);
    }
  });

  it("insideBar never makes a new extreme", () => {
    const w = randomWalk(50, { seed: 4 });
    const b = insideBar(w);
    const p = w[w.length - 1];
    expect(b.high).toBeLessThanOrEqual(p?.high ?? 0);
    expect(b.low).toBeGreaterThanOrEqual(p?.low ?? Infinity);
    expect(b.openTime).toBe((p?.openTime ?? 0) + 3_600_000);
  });
});
