import { describe, expect, it } from "vitest";
import {
  clampToPriceBound,
  decimalsFromStep,
  formatPrice,
  formatSize,
  formatToStep,
  isWithinPriceBound,
} from "./precision.js";

describe("decimalsFromStep", () => {
  it("reads decimals from string and numeric steps", () => {
    expect(decimalsFromStep("0.00001")).toBe(5);
    expect(decimalsFromStep("0.10")).toBe(1);
    expect(decimalsFromStep(0.1)).toBe(1);
    expect(decimalsFromStep(0.00001)).toBe(5);
    expect(decimalsFromStep("1")).toBe(0);
    expect(decimalsFromStep("0.001")).toBe(3);
  });
  it("rejects invalid steps", () => {
    expect(() => decimalsFromStep("0")).toThrow();
    expect(() => decimalsFromStep("abc")).toThrow();
  });
});

describe("formatSize / formatPrice (BTC-USD defaults)", () => {
  it("floors sizes to 5 decimals and never rounds up", () => {
    expect(formatSize(0.123456789)).toBe("0.12345");
    expect(formatSize(0.1)).toBe("0.10000");
    expect(formatSize(0.00001)).toBe("0.00001");
    expect(formatSize(0.000019)).toBe("0.00001");
    expect(formatSize(-0.25)).toBe("0.25000");
    expect(formatSize(0.3 - 0.1)).toBe("0.20000");
  });
  it("rounds prices to the 0.1 tick", () => {
    expect(formatPrice(79765.74)).toBe("79765.7");
    expect(formatPrice(79765.75)).toBe("79765.8");
    expect(formatPrice(78000)).toBe("78000.0");
    expect(formatPrice(78000.04, "0.1", "ceil")).toBe("78000.1");
    expect(formatPrice(78000.09, "0.1", "floor")).toBe("78000.0");
  });
  it("uses tick/step from exchangeInfo when given", () => {
    expect(formatToStep(2345.678, "0.01")).toBe("2345.68");
    expect(formatToStep(12.3456, 0.001, "floor")).toBe("12.345");
    expect(formatToStep(3, "1")).toBe("3");
  });
  it("rejects non-finite input", () => {
    expect(() => formatSize(Number.NaN)).toThrow();
  });
});

describe("price bound", () => {
  it("accepts prices within 5% of mark and rejects beyond", () => {
    expect(isWithinPriceBound(76_000, 80_000, 0.05)).toBe(true);
    expect(isWithinPriceBound(84_000, 80_000, 0.05)).toBe(true);
    expect(isWithinPriceBound(75_999, 80_000, 0.05)).toBe(false);
    expect(isWithinPriceBound(84_001, 80_000, 0.05)).toBe(false);
    expect(isWithinPriceBound(80_000, 0, 0.05)).toBe(false);
  });
  it("clamps into the band", () => {
    expect(clampToPriceBound(70_000, 80_000, 0.05)).toBe(76_000);
    expect(clampToPriceBound(90_000, 80_000, 0.05)).toBe(84_000);
    expect(clampToPriceBound(79_000, 80_000, 0.05)).toBe(79_000);
  });
});
