import { describe, expect, it } from "vitest";
import { computeOutcome } from "./outcome.js";
import { summarizeCalibration, formatCalibrationForPrompt } from "./calibration.js";

describe("computeOutcome", () => {
  const candle = (openTime: number, low: number, high: number) => ({
    venue: "strike",
    symbol: "BTC-USD",
    interval: "1h" as const,
    openTime,
    closeTime: openTime + 3_599_999,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 1,
  });

  it("computes R, MAE and MFE for a winning long", () => {
    const o = computeOutcome({
      direction: "long",
      entryPrice: 78_000,
      exitPrice: 82_000,
      size: 0.05,
      initialStop: 76_000,
      fees: 4,
      fundingPaid: 1,
      openedAt: 0,
      closedAt: 3 * 3_600_000,
      candles: [candle(0, 77_000, 78_500), candle(3_600_000, 77_800, 81_000), candle(7_200_000, 80_000, 82_500)],
    });
    expect(o.grossPnl).toBeCloseTo(200);
    expect(o.netPnl).toBeCloseTo(195);
    expect(o.riskUsd).toBeCloseTo(100);
    expect(o.realizedR).toBeCloseTo(1.95);
    expect(o.maeR).toBeCloseTo(-0.5);
    expect(o.mfeR).toBeCloseTo(2.25);
    expect(o.outcome).toBe("win");
    expect(o.holdHours).toBe(3);
  });

  it("handles a stopped-out short as a loss of about -1R", () => {
    const o = computeOutcome({
      direction: "short",
      entryPrice: 80_000,
      exitPrice: 81_000,
      size: 0.1,
      initialStop: 81_000,
      fees: 8,
      fundingPaid: -2,
      openedAt: 0,
      closedAt: 3_600_000,
      candles: [],
    });
    expect(o.realizedR).toBeCloseTo(-1.06);
    expect(o.outcome).toBe("loss");
  });
});

describe("summarizeCalibration", () => {
  it("buckets by confidence, setup and prior", () => {
    const c = summarizeCalibration([
      { confidence: "high", setup: "wave-2-end", hadPrior: true, realizedR: 2, outcome: "win" },
      { confidence: "high", setup: "wave-2-end", hadPrior: true, realizedR: -1, outcome: "loss" },
      { confidence: "medium", setup: "wave-4-end", hadPrior: false, realizedR: 0.05, outcome: "scratch" },
    ]);
    expect(c.totalTrades).toBe(3);
    expect(c.byConfidence.high.n).toBe(2);
    expect(c.byConfidence.high.winRate).toBe(0.5);
    expect(c.byConfidence.high.avgR).toBe(0.5);
    expect(c.byConfidence.high.brier).toBeCloseTo(((0.7 - 1) ** 2 + (0.7 - 0) ** 2) / 2);
    expect(c.bySetup["wave-4-end"]!.n).toBe(1);
    expect(c.withPrior.n).toBe(2);
    expect(c.withoutPrior.n).toBe(1);
    expect(formatCalibrationForPrompt(c)).toContain("high: n=2 win=50%");
    expect(formatCalibrationForPrompt(summarizeCalibration([]))).toMatch(/No closed trades/);
  });
});
