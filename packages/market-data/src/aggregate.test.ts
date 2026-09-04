import { describe, expect, it } from "vitest";
import { HOUR, candle, candles } from "./__fixtures__/helpers.js";
import { aggregate, alignAndFill, normalizeSeries } from "./aggregate.js";

const DAY = Date.UTC(2026, 8, 1); // 00:00 UTC

describe("normalizeSeries", () => {
  it("sorts ascending and lets the last duplicate win", () => {
    const a = candle(HOUR, { close: 1 });
    const b = candle(0);
    const a2 = candle(HOUR, { close: 2 });
    expect(normalizeSeries([a, b, a2]).map((c) => [c.openTime, c.close])).toEqual([
      [0, b.close],
      [HOUR, 2],
    ]);
  });
});

describe("aggregate 1h -> 4h", () => {
  it("aligns buckets to UTC 00/04/08… and rolls OHLCV correctly", () => {
    const src = candles(DAY + HOUR, 12); // 01:00 … 12:00 — first bucket (00-03) incomplete, 04-07 and 08-11 complete, 12 partial
    const out = aggregate(src, "4h");
    expect(out.map((c) => c.openTime)).toEqual([DAY + 4 * HOUR, DAY + 8 * HOUR]);
    const b = out[0]!;
    const parts = src.slice(3, 7); // 04,05,06,07
    expect(b.open).toBe(parts[0]!.open);
    expect(b.close).toBe(parts[3]!.close);
    expect(b.high).toBe(Math.max(...parts.map((c) => c.high)));
    expect(b.low).toBe(Math.min(...parts.map((c) => c.low)));
    expect(b.volume).toBe(4);
    expect(b.closeTime).toBe(DAY + 8 * HOUR - 1);
    expect(b).toMatchObject({ venue: "test", symbol: "BTC-USD", interval: "4h" });
  });

  it("emits partial buckets only when requireComplete is false", () => {
    const src = candles(DAY, 6); // 00..05
    expect(aggregate(src, "4h").map((c) => c.openTime)).toEqual([DAY]);
    const loose = aggregate(src, "4h", { requireComplete: false });
    expect(loose.map((c) => c.openTime)).toEqual([DAY, DAY + 4 * HOUR]);
    expect(loose[1]!.close).toBe(src[5]!.close);
  });

  it("does not treat a bucket with a hole as complete", () => {
    const src = candles(DAY, 8).filter((c) => c.openTime !== DAY + 2 * HOUR);
    expect(aggregate(src, "4h").map((c) => c.openTime)).toEqual([DAY + 4 * HOUR]);
  });

  it("builds 1d and 4h from 1h, refuses same/finer/non-dividing targets and mixed venues", () => {
    expect(aggregate(candles(DAY, 24), "1d")).toHaveLength(1);
    expect(aggregate(candles(DAY, 24, { interval: "4h" }).map((c, i) => ({ ...c, openTime: DAY + i * 4 * HOUR, closeTime: DAY + (i + 1) * 4 * HOUR - 1 })), "1d")).toHaveLength(4);
    expect(() => aggregate(candles(DAY, 4), "1h")).toThrow(RangeError);
    expect(() => aggregate([candle(DAY, { interval: "4h", closeTime: DAY + 4 * HOUR - 1 })], "1h")).toThrow(RangeError);
    expect(() => aggregate([candle(DAY), candle(DAY + HOUR, { venue: "other" })], "4h")).toThrow(/mixed/);
    expect(() => aggregate([candle(DAY), candle(DAY + HOUR + 1)], "4h")).toThrow(/misaligned/);
    expect(aggregate([], "4h")).toEqual([]);
  });
});

describe("alignAndFill", () => {
  it("reports gaps without inventing candles by default", () => {
    const src = candles(DAY, 10).filter((c) => ![DAY + 3 * HOUR, DAY + 4 * HOUR, DAY + 7 * HOUR].includes(c.openTime));
    const res = alignAndFill(src, "1h");
    expect(res.candles).toHaveLength(7);
    expect(res.filled).toEqual([]);
    expect(res.gaps).toEqual([
      { from: DAY + 3 * HOUR, to: DAY + 4 * HOUR, missing: 2 },
      { from: DAY + 7 * HOUR, to: DAY + 7 * HOUR, missing: 1 },
    ]);
  });

  it("fill:true inserts flat candles at the previous close and lists every synthetic openTime", () => {
    const src = candles(DAY, 5).filter((c) => c.openTime !== DAY + 2 * HOUR);
    const res = alignAndFill(src, "1h", { fill: true });
    expect(res.candles.map((c) => c.openTime)).toEqual([0, 1, 2, 3, 4].map((i) => DAY + i * HOUR));
    expect(res.filled).toEqual([DAY + 2 * HOUR]);
    const synthetic = res.candles[2]!;
    const prev = res.candles[1]!;
    expect(synthetic).toMatchObject({ open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0, closeTime: DAY + 3 * HOUR - 1 });
    expect(res.gaps).toHaveLength(1);
  });

  it("separates off-grid and wrong-interval candles and dedupes the rest", () => {
    const bad1 = candle(DAY + 30 * 60_000);
    const bad2 = candle(DAY, { interval: "4h" });
    const res = alignAndFill([candle(DAY + HOUR), candle(DAY), bad1, bad2, candle(DAY + HOUR)], "1h");
    expect(res.misaligned).toEqual([bad1, bad2]);
    expect(res.candles.map((c) => c.openTime)).toEqual([DAY, DAY + HOUR]);
    expect(res.gaps).toEqual([]);
  });
});
