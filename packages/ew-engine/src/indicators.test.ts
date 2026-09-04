import { describe, expect, it } from "vitest";
import type { Candle, Swing } from "@surf/core";
import { atr, atrWithWarmup, divergenceBetween, rsi, rsiDivergence, trueRange } from "./indicators.js";

function candle(i: number, high: number, low: number, close: number, open = close): Candle {
  return {
    venue: "t",
    symbol: "BTC-USD",
    interval: "1h",
    openTime: i * 3_600_000,
    closeTime: (i + 1) * 3_600_000 - 1,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}

describe("rsi", () => {
  it("matches hand-computed Wilder RSI (period 3)", () => {
    // closes: 10, 11, 10.5, 11.5, 12, 11
    // first window: gains 1 + 1 = 2 → avgGain 2/3; losses 0.5 → avgLoss 0.5/3; RS = 4 → RSI 80
    // i=4: d=+0.5 → avgGain (2/3·2+0.5)/3 = 0.6111, avgLoss (0.1667·2)/3 = 0.1111 → RS 5.5 → 84.615
    // i=5: d=-1  → avgGain 0.4074, avgLoss (0.1111·2+1)/3 = 0.4074 → RS 1 → 50
    const out = rsi([10, 11, 10.5, 11.5, 12, 11], 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo(80, 6);
    expect(out[4]).toBeCloseTo(84.6153846, 5);
    expect(out[5]).toBeCloseTo(50, 6);
  });

  it("returns 100 for monotone gains and 50 for a flat series", () => {
    const up = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up[5]).toBe(100);
    const flat = rsi([5, 5, 5, 5, 5], 3);
    expect(flat[4]).toBe(50);
  });

  it("is all null when the series is too short", () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
    expect(rsi([], 14)).toEqual([]);
  });
});

describe("atr", () => {
  const candles = [
    candle(0, 10, 9, 9.5),
    candle(1, 11, 9.8, 10.5), // TR = max(1.2, |11-9.5|=1.5, |9.8-9.5|=0.3) = 1.5
    candle(2, 10.8, 10.0, 10.2), // TR = max(0.8, 0.3, 0.5) = 0.8
    candle(3, 12, 10.1, 11.9), // TR = max(1.9, 1.8, 0.1) = 1.9
  ];

  it("computes true range with the previous close", () => {
    expect(trueRange(candles, 0)).toBeCloseTo(1);
    expect(trueRange(candles, 1)).toBeCloseTo(1.5);
    expect(trueRange(candles, 2)).toBeCloseTo(0.8);
    expect(trueRange(candles, 3)).toBeCloseTo(1.9);
  });

  it("matches hand-computed Wilder ATR (period 2)", () => {
    const out = atr(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo((1.5 + 0.8) / 2, 9); // 1.15
    expect(out[3]).toBeCloseTo((1.15 * 1 + 1.9) / 2, 9); // 1.525
  });

  it("warm-up variant is defined everywhere and causal", () => {
    const w = atrWithWarmup(candles, 2);
    expect(w[0]).toBeCloseTo(1); // TR0
    expect(w[1]).toBeCloseTo((1 + 1.5) / 2); // expanding mean
    expect(w[2]).toBeCloseTo(1.15);
    expect(w[3]).toBeCloseTo(1.525);
    const prefix = atrWithWarmup(candles.slice(0, 3), 2);
    expect(prefix).toEqual(w.slice(0, 3));
  });

  it("handles short inputs", () => {
    expect(atr([], 14)).toEqual([]);
    expect(atr(candles, 14).every((v) => v === null)).toBe(true);
  });
});

describe("rsiDivergence", () => {
  const swing = (index: number, price: number, kind: "high" | "low"): Swing => ({ index, time: index, price, kind });

  it("detects bearish divergence: higher high, lower RSI", () => {
    const series = [null, 75, null, 65];
    expect(divergenceBetween(swing(1, 100, "high"), swing(3, 105, "high"), series)).toBe("bearish");
    expect(rsiDivergence([swing(0, 90, "low"), swing(1, 100, "high"), swing(2, 95, "low"), swing(3, 105, "high")], series)).toBe(
      "bearish",
    );
  });

  it("detects bullish divergence: lower low, higher RSI", () => {
    const series = [25, null, 35, null];
    expect(divergenceBetween(swing(0, 100, "low"), swing(2, 95, "low"), series)).toBe("bullish");
    expect(rsiDivergence([swing(0, 100, "low"), swing(1, 110, "high"), swing(2, 95, "low"), swing(3, 105, "high")], series)).toBe(
      "bullish",
    );
  });

  it("returns none without divergence, mismatched kinds or missing RSI", () => {
    expect(divergenceBetween(swing(0, 100, "high"), swing(2, 105, "high"), [60, null, 70])).toBe("none");
    expect(divergenceBetween(swing(0, 100, "high"), swing(2, 105, "low"), [70, null, 60])).toBe("none");
    expect(divergenceBetween(swing(0, 100, "high"), swing(2, 105, "high"), [null, null, 60])).toBe("none");
    expect(rsiDivergence([swing(0, 100, "low")], [50])).toBe("none");
  });

  it("prefers the divergence with the more recent pivot when both exist", () => {
    const swings = [swing(0, 100, "low"), swing(1, 110, "high"), swing(2, 95, "low"), swing(3, 112, "high")];
    // lows: 100 → 95 with RSI 20 → 40 (bullish, pivot 2); highs: 110 → 112 with RSI 80 → 70 (bearish, pivot 3)
    expect(rsiDivergence(swings, [20, 80, 40, 70])).toBe("bearish");
    const swings2 = [swing(0, 110, "high"), swing(1, 100, "low"), swing(2, 112, "high"), swing(3, 95, "low")];
    expect(rsiDivergence(swings2, [80, 20, 70, 40])).toBe("bullish");
  });
});
