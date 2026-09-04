import { describe, expect, it } from "vitest";
import { HOUR, coinbaseRow, fakeFetch, jsonResponse, loadFixture } from "../__fixtures__/helpers.js";
import { HttpError, Pacer } from "../http.js";
import { backfillCoinbase, coinbaseWindows, fetchCoinbaseCandles, granularityFor, parseCoinbaseCandles } from "./coinbase.js";

describe("parseCoinbaseCandles (recorded fixture)", () => {
  const raw = loadFixture<number[][]>("coinbase-candles-1h.json");

  it("maps [time_s, low, high, open, close, volume] and flips to ascending order", () => {
    expect(raw[0]![0]).toBeGreaterThan(raw[1]![0]); // fixture is newest first
    const out = parseCoinbaseCandles(raw, { product: "BTC-USD", granularity: 3600 });
    expect(out).toHaveLength(raw.length);
    const newest = out[out.length - 1]!;
    expect(newest).toMatchObject({ venue: "coinbase", symbol: "BTC-USD", interval: "1h", openTime: 1788537600000, closeTime: 1788541199999 });
    expect(newest.low).toBe(79374.5);
    expect(newest.high).toBe(79875.32);
    expect(newest.open).toBe(79422.95);
    expect(newest.close).toBe(79764.74);
    expect(newest.volume).toBeCloseTo(278.20408097, 8);
    for (let i = 1; i < out.length; i++) expect(out[i]!.openTime - out[i - 1]!.openTime).toBe(HOUR);
  });

  it("rejects rows of the wrong width or type", () => {
    expect(() => parseCoinbaseCandles([[1, 2, 3]], { product: "BTC-USD", granularity: 3600 })).toThrow();
    expect(() => parseCoinbaseCandles([["1", 2, 3, 4, 5, 6]], { product: "BTC-USD", granularity: 3600 })).toThrow();
  });

  it("granularityFor maps core intervals", () => {
    expect(granularityFor("1h")).toBe(3600);
    expect(granularityFor("4h")).toBe(14400);
    expect(granularityFor("1d")).toBe(86400);
  });
});

describe("fetchCoinbaseCandles", () => {
  it("sends ISO start/end and granularity", async () => {
    const fetch = fakeFetch(() => [coinbaseRow(HOUR)]);
    await fetchCoinbaseCandles({ fetch, product: "BTC-USD", granularity: 3600, start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 1, 5) });
    const u = fetch.calls[0]!;
    expect(u.origin + u.pathname).toBe("https://api.exchange.coinbase.com/products/BTC-USD/candles");
    expect(Object.fromEntries(u.searchParams)).toEqual({ granularity: "3600", start: "2026-09-01T00:00:00.000Z", end: "2026-09-01T05:00:00.000Z" });
  });

  it("surfaces the 400 for oversized ranges as HttpError", async () => {
    const fetch = fakeFetch(() => jsonResponse({ message: "granularity too small for the requested time range. Count of aggregations requested exceeds 300" }, 400));
    await expect(fetchCoinbaseCandles({ fetch, product: "BTC-USD", granularity: 3600 })).rejects.toMatchObject({ name: "HttpError", status: 400 });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("backfillCoinbase", () => {
  const T0 = Date.UTC(2026, 0, 1);

  it("coinbaseWindows covers [from, to] in inclusive 300-candle windows", () => {
    const w = coinbaseWindows(T0, T0 + 700 * HOUR, 3600);
    expect(w).toHaveLength(3);
    expect(w[0]).toEqual({ start: T0, end: T0 + 299 * HOUR });
    expect(w[1]).toEqual({ start: T0 + 300 * HOUR, end: T0 + 599 * HOUR });
    expect(w[2]).toEqual({ start: T0 + 600 * HOUR, end: T0 + 700 * HOUR });
    expect(coinbaseWindows(T0, T0, 3600)).toEqual([{ start: T0, end: T0 }]);
  });

  it("walks windows, paces requests, and returns a deduped ascending series", async () => {
    const server = fakeFetch((u) => {
      const start = Date.parse(u.searchParams.get("start")!);
      const end = Date.parse(u.searchParams.get("end")!);
      expect((end - start) / HOUR + 1).toBeLessThanOrEqual(300);
      const rows: number[][] = [];
      for (let t = end; t >= start; t -= HOUR) rows.push(coinbaseRow(t)); // newest first, like the real API
      return rows;
    });
    const sleeps: number[] = [];
    let now = 0;
    const pacer = new Pacer(200, { now: () => now, sleep: async (ms) => void sleeps.push(ms) });
    const out = await backfillCoinbase({ fetch: server, product: "BTC-USD", granularity: 3600, from: T0, to: T0 + 700 * HOUR, pacer });
    expect(server.calls).toHaveLength(3);
    expect(out).toHaveLength(701);
    expect(out[0]!.openTime).toBe(T0);
    expect(out[700]!.openTime).toBe(T0 + 700 * HOUR);
    expect(sleeps).toEqual([200, 400]); // clock frozen, so each call waits for the previous slot
    now += 10_000;
    await pacer.wait();
    expect(sleeps).toHaveLength(2); // once the clock has moved on, no sleep is needed
  });

  it("propagates HttpError from a window instead of skipping it", async () => {
    let n = 0;
    const server = fakeFetch(() => (++n === 2 ? jsonResponse({ message: "NotFound" }, 404) : [coinbaseRow(T0)]));
    await expect(backfillCoinbase({ fetch: server, product: "BTC-USD", granularity: 3600, from: T0, to: T0 + 400 * HOUR, pacer: new Pacer(0) })).rejects.toBeInstanceOf(HttpError);
  });
});
