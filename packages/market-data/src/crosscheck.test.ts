import { describe, expect, it } from "vitest";
import { HOUR, candle } from "./__fixtures__/helpers.js";
import { crossCheck, referencePrice } from "./crosscheck.js";

const T = Date.UTC(2026, 8, 4, 9);

describe("crossCheck", () => {
  const strike = candle(T, { venue: "strike", close: 80_000 });

  it("passes when closes of the same bucket agree within the threshold", () => {
    const res = crossCheck(strike, candle(T, { venue: "coinbase", close: 80_400 }), 1);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
    expect(res.deviationPct).toBeCloseTo(0.4975, 3);
    expect(res.primary?.venue).toBe("strike");
    expect(res.secondary?.venue).toBe("coinbase");
  });

  it("fails above the threshold (deviation measured against the secondary close)", () => {
    const res = crossCheck(strike, candle(T, { venue: "coinbase", close: 81_000 }), 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("deviation-exceeded");
    expect(res.deviationPct).toBeCloseTo((1000 / 81_000) * 100, 6);
  });

  it("threshold is inclusive", () => {
    expect(crossCheck(strike, candle(T, { venue: "coinbase", close: 80_000 / 1.01 }), 1).ok).toBe(true);
    expect(crossCheck(strike, candle(T, { venue: "coinbase", close: 80_000 / 1.0101 }), 1).ok).toBe(false);
  });

  it("missing secondary and bucket/interval mismatches are not ok and carry no deviation", () => {
    expect(crossCheck(strike, null, 1)).toMatchObject({ ok: false, reason: "no-secondary", deviationPct: null, secondary: null });
    expect(crossCheck(strike, candle(T - HOUR, { venue: "coinbase", close: 80_000 }), 1)).toMatchObject({ ok: false, reason: "bucket-mismatch", deviationPct: null });
    expect(crossCheck(strike, candle(T, { venue: "coinbase", interval: "4h", close: 80_000 }), 1)).toMatchObject({ ok: false, reason: "interval-mismatch" });
  });
});

describe("referencePrice", () => {
  it("prefers Coinbase, falls back to Strike index, else null", () => {
    expect(referencePrice(80_100, 80_000)).toBe(80_100);
    expect(referencePrice(null, 80_000)).toBe(80_000);
    expect(referencePrice(null, null)).toBeNull();
    expect(referencePrice(0, 80_000)).toBe(80_000);
    expect(referencePrice(Number.NaN, null)).toBeNull();
  });
});
