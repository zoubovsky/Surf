import { describe, expect, it } from "vitest";
import { candlesFromPath, syntheticImpulse } from "./synthetic.js";
import { zigzag, zigzagDegrees, zigzagDetailed } from "./zigzag.js";

describe("zigzag", () => {
  const series = syntheticImpulse({ seed: 5, tail: [{ price: 116, bars: 12 }] });

  it("finds exactly the six impulse pivots on a textbook series, at every degree", () => {
    for (const k of [1.5, 3, 6]) {
      const z = zigzagDetailed(series.candles, { k });
      // The tail leg adds a seventh (still provisional) pivot to the generator's list.
      expect(z.confirmed.map((s) => s.index)).toEqual(series.pivotIndices.slice(0, 6));
      z.confirmed.forEach((s, i) => expect(s.price).toBeCloseTo(series.pivotPrices[i] ?? NaN, 9));
      expect(z.provisional?.index).toBe(series.pivotIndices[6]);
      expect(z.confirmed.map((s) => s.kind)).toEqual(["low", "high", "low", "high", "low", "high"]);
      expect(z.provisional?.kind).toBe("low");
      expect(z.trend).toBe(-1);
    }
  });

  it("strictly alternates and pairs each pivot with its candle time", () => {
    const swings = zigzag(series.candles, { k: 3 });
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i]?.kind).not.toBe(swings[i - 1]?.kind);
      expect(swings[i]?.index).toBeGreaterThan(swings[i - 1]?.index ?? -1);
    }
    for (const s of swings) expect(s.time).toBe(series.candles[s.index]?.openTime);
  });

  it("replaces the provisional pivot while the leg extends, without touching confirmed pivots", () => {
    const up = candlesFromPath(100, [{ price: 120, bars: 40 }, { price: 110, bars: 20 }], { seed: 2 });
    const a = zigzagDetailed(up.candles.slice(0, 20), { k: 3 });
    const b = zigzagDetailed(up.candles.slice(0, 35), { k: 3 });
    expect(a.confirmed.map((s) => s.index)).toEqual([0]);
    expect(b.confirmed.map((s) => s.index)).toEqual([0]);
    expect(a.provisional?.kind).toBe("high");
    expect(b.provisional?.kind).toBe("high");
    expect(b.provisional?.index ?? 0).toBeGreaterThan(a.provisional?.index ?? 0);
    expect(b.provisional?.price ?? 0).toBeGreaterThan(a.provisional?.price ?? 0);
    const full = zigzagDetailed(up.candles, { k: 3 });
    expect(full.confirmed.map((s) => s.index)).toEqual([0, 39]);
  });

  it("is causal: confirmed pivots of a prefix are a prefix of the full run", () => {
    const full = zigzag(series.candles, { k: 3 });
    for (const cut of [15, 30, 45, 60, 75, 90, 105]) {
      const prefix = zigzag(series.candles.slice(0, cut), { k: 3 });
      expect(prefix).toEqual(full.slice(0, prefix.length));
    }
  });

  it("coarser degrees never produce more pivots than finer ones", () => {
    const [fine, mid, coarse] = zigzagDegrees(series.candles, [6, 1.5, 3]);
    expect(fine?.k).toBe(1.5);
    expect(coarse?.k).toBe(6);
    expect(fine?.confirmed.length ?? 0).toBeGreaterThanOrEqual(mid?.confirmed.length ?? 0);
    expect(mid?.confirmed.length ?? 0).toBeGreaterThanOrEqual(coarse?.confirmed.length ?? 0);
  });

  it("handles empty, single and warm-up-length inputs", () => {
    expect(zigzagDetailed([], { k: 3 })).toEqual({ k: 3, confirmed: [], provisional: null, trend: 0 });
    const one = zigzagDetailed(series.candles.slice(0, 1), { k: 3 });
    expect(one.confirmed).toEqual([]);
    expect(one.provisional).toBeNull();
    const short = zigzagDetailed(series.candles.slice(0, 10), { k: 3 });
    expect(short.confirmed.length).toBeLessThanOrEqual(1);
    expect(() => zigzag(series.candles.slice(0, 14), { k: 1.5 })).not.toThrow();
  });

  it("rejects a non-positive k", () => {
    expect(() => zigzag(series.candles, { k: 0 })).toThrow(RangeError);
  });

  it("starts with a high pivot when the series falls first", () => {
    const down = syntheticImpulse({ dir: -1, seed: 9, tail: [{ price: 84, bars: 12 }] });
    const z = zigzagDetailed(down.candles, { k: 3 });
    expect(z.confirmed.map((s) => s.kind)).toEqual(["high", "low", "high", "low", "high", "low"]);
    expect(z.provisional?.kind).toBe("high");
  });
});
