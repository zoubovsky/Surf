import { describe, expect, it } from "vitest";
import { HOUR, candle, candles } from "./__fixtures__/helpers.js";
import { CandleSeries } from "./store.js";

const T0 = Date.UTC(2026, 8, 1);

describe("CandleSeries", () => {
  it("keeps candles sorted and deduped by openTime; a later upsert replaces", () => {
    const s = new CandleSeries("1h");
    const r1 = s.upsert([candle(T0 + 2 * HOUR), candle(T0), candle(T0 + HOUR)]);
    expect(r1).toEqual({ inserted: 3, updated: 0, evicted: 0 });
    const r2 = s.upsert([candle(T0 + HOUR, { close: 123 }), candle(T0 + 3 * HOUR)]);
    expect(r2).toEqual({ inserted: 1, updated: 1, evicted: 0 });
    expect(s.all().map((c) => c.openTime)).toEqual([0, 1, 2, 3].map((i) => T0 + i * HOUR));
    expect(s.at(T0 + HOUR)?.close).toBe(123);
    expect(s.at(T0 + HOUR + 1)).toBeUndefined();
    expect(s.size).toBe(4);
  });

  it("refuses candles of another interval", () => {
    const s = new CandleSeries("1h");
    expect(() => s.upsert([candle(T0, { interval: "4h" })])).toThrow(/refusing 4h/);
  });

  it("latestClosed never returns a candle whose closeTime > now", () => {
    const s = new CandleSeries("1h");
    s.upsert(candles(T0, 5)); // 00..04; the 04 candle closes at 04:59:59.999
    const c4 = s.at(T0 + 4 * HOUR)!;
    expect(s.latestClosed(c4.closeTime - 1)?.openTime).toBe(T0 + 3 * HOUR);
    expect(s.latestClosed(c4.closeTime)?.openTime).toBe(T0 + 4 * HOUR); // exactly at close counts as closed
    expect(s.latestClosed(c4.closeTime + 1)?.openTime).toBe(T0 + 4 * HOUR);
    expect(s.latestClosed(T0 + 4 * HOUR + 30 * 60_000)?.openTime).toBe(T0 + 3 * HOUR); // mid-candle
    expect(s.latestClosed(T0)).toBeUndefined();
    expect(s.latestClosed(T0 + HOUR - 1)?.openTime).toBe(T0);
    for (let now = T0; now < T0 + 6 * HOUR; now += 17 * 60_000) {
      const c = s.latestClosed(now);
      if (c) expect(c.closeTime).toBeLessThanOrEqual(now);
    }
  });

  it("latest() may be the open candle, slice/sliceClosed/closedUpTo differ accordingly", () => {
    const s = new CandleSeries("1h");
    s.upsert(candles(T0, 5));
    const now = T0 + 4 * HOUR + 10 * 60_000; // 04:10 — the 04:00 candle is open
    expect(s.latest()?.openTime).toBe(T0 + 4 * HOUR);
    expect(s.slice(2).map((c) => c.openTime)).toEqual([T0 + 3 * HOUR, T0 + 4 * HOUR]);
    expect(s.sliceClosed(2, now).map((c) => c.openTime)).toEqual([T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(s.closedUpTo(now)).toHaveLength(4);
    expect(s.closedUpTo(now).every((c) => c.closeTime <= now)).toBe(true);
    expect(s.slice(0)).toEqual([]);
    expect(s.slice(99)).toHaveLength(5);
    expect(s.sliceClosed(99, now)).toHaveLength(4);
  });

  it("range is inclusive on both openTime bounds", () => {
    const s = new CandleSeries("1h");
    s.upsert(candles(T0, 6));
    expect(s.range(T0 + HOUR, T0 + 3 * HOUR).map((c) => c.openTime)).toEqual([1, 2, 3].map((i) => T0 + i * HOUR));
    expect(s.range(T0 + HOUR + 1, T0 + 3 * HOUR - 1).map((c) => c.openTime)).toEqual([T0 + 2 * HOUR]);
    expect(s.range(T0 + 99 * HOUR, T0 + 100 * HOUR)).toEqual([]);
  });

  it("evicts the oldest candles beyond maxLength", () => {
    const s = new CandleSeries("1h", { maxLength: 3 });
    const r = s.upsert(candles(T0, 5));
    expect(r.evicted).toBe(2);
    expect(s.first()?.openTime).toBe(T0 + 2 * HOUR);
    expect(s.size).toBe(3);
    s.upsert([candle(T0)]); // older than everything kept → inserted then evicted again
    expect(s.first()?.openTime).toBe(T0 + 2 * HOUR);
  });
});
