import { describe, expect, it } from "vitest";
import { expectedFundingUsd, roundToStep, roundToTick, sizePosition } from "./sizing.js";

describe("sizing", () => {
  it("rounds to step and tick", () => {
    expect(roundToStep(0.043478, 0.00001)).toBe(0.04347);
    expect(roundToStep(1.99999999, 0.00001)).toBe(1.99999);
    expect(roundToTick(79_123.456, 0.1)).toBe(79_123.5);
    expect(roundToTick(79_123.44, 0.1)).toBe(79_123.4);
  });

  it("sizes from fixed-fraction risk", () => {
    const r = sizePosition({
      equity: 10_000,
      riskPct: 1,
      entryPrice: 78_000,
      stopLoss: 76_000,
      direction: "long",
      maxLeverage: 5,
      sizeStep: 0.00001,
      minNotionalUsd: 10,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.size).toBe(0.05);
    expect(r.riskUsd).toBeCloseTo(100, 6);
    expect(r.notionalUsd).toBe(3_900);
    expect(r.leverage).toBe(1);
  });

  it("cuts size to the leverage cap", () => {
    const r = sizePosition({
      equity: 1_000,
      riskPct: 2,
      entryPrice: 80_000,
      stopLoss: 79_950,
      direction: "long",
      maxLeverage: 5,
      sizeStep: 0.00001,
      minNotionalUsd: 10,
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.notionalUsd).toBeLessThanOrEqual(5_000);
    expect(r.leverage).toBeLessThanOrEqual(5);
    expect(r.riskUsd).toBeLessThan(20);
  });

  it("rejects a stop on the wrong side and tiny notionals", () => {
    expect(
      sizePosition({ equity: 1_000, riskPct: 1, entryPrice: 80_000, stopLoss: 81_000, direction: "long", maxLeverage: 5, sizeStep: 0.00001, minNotionalUsd: 10 }),
    ).toHaveProperty("error");
    expect(
      sizePosition({ equity: 5, riskPct: 1, entryPrice: 80_000, stopLoss: 70_000, direction: "long", maxLeverage: 5, sizeStep: 0.00001, minNotionalUsd: 10 }),
    ).toHaveProperty("error");
  });

  it("funding sign: longs pay positive funding, shorts receive it", () => {
    expect(expectedFundingUsd(10_000, 0.0001, 10, "long")).toBeCloseTo(10);
    expect(expectedFundingUsd(10_000, 0.0001, 10, "short")).toBeCloseTo(-10);
  });
});
