import { describe, expect, it } from "vitest";
import { HOUR, fakeFetch, jsonResponse, klineRow, loadFixture } from "../__fixtures__/helpers.js";
import { HttpError } from "../http.js";
import {
  STRIKE_KLINES_MAX_LIMIT,
  backfillStrikeKlines,
  fetchStrikeFundingHistory,
  fetchStrikeKlines,
  fetchStrikeOpenInterestHistory,
  fetchStrikePremiumIndex,
  parseStrikeFundingHistory,
  parseStrikeKlines,
  parseStrikeOpenInterestHistory,
  parseStrikePremiumIndex,
} from "./strike.js";

describe("parseStrikeKlines (recorded fixture)", () => {
  const raw = loadFixture<unknown[][]>("strike-klines-index-1h.json");

  it("maps the 12-element rows to Candle with venue strike", () => {
    const out = parseStrikeKlines(raw, { symbol: "BTC-USD", interval: "1h" });
    expect(out).toHaveLength(raw.length);
    const first = out[0]!;
    expect(first).toMatchObject({
      venue: "strike",
      symbol: "BTC-USD",
      interval: "1h",
      openTime: 1788508800000,
      closeTime: 1788512399999,
    });
    expect(first.open).toBeCloseTo(80630.52574234, 6);
    expect(first.high).toBeCloseTo(81222.36742684, 6);
    expect(first.low).toBeCloseTo(80502.90111308, 6);
    expect(first.close).toBeCloseTo(81132.09224999, 6);
    expect(first.volume).toBeCloseTo(1.36508, 6);
  });

  it("returns ascending, hourly-aligned candles", () => {
    const out = parseStrikeKlines(raw, { symbol: "BTC-USD", interval: "1h" });
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.openTime - out[i - 1]!.openTime).toBe(HOUR);
      expect(out[i]!.openTime % HOUR).toBe(0);
    }
  });

  it("rejects malformed rows", () => {
    expect(() => parseStrikeKlines([[1, "x"]], { symbol: "BTC-USD", interval: "1h" })).toThrow();
    expect(() =>
      parseStrikeKlines([[1, "nope", "1", "1", "1", "1", 2, "1", 1, "1", "1", "0"]], {
        symbol: "BTC-USD",
        interval: "1h",
      }),
    ).toThrow(/finite/);
  });
});

describe("Strike stats parsers (recorded fixtures)", () => {
  it("funding history: columns [ts, funding_rate], hourly points, days + symbol", () => {
    const raw = loadFixture<{ columns: string[]; data: unknown[][]; days: number; symbol: string }>(
      "strike-funding-history.json",
    );
    expect(raw.columns).toEqual(["ts", "funding_rate"]);
    const out = parseStrikeFundingHistory(raw);
    expect(out.symbol).toBe("BTC-USD");
    expect(out.days).toBe(30);
    expect(out.points).toHaveLength(raw.data.length);
    expect(out.points[0]).toEqual({ ts: 1785949200000, fundingRate: 0.0000125 });
    expect(out.points[1]!.ts - out.points[0]!.ts).toBe(HOUR);
    for (let i = 1; i < out.points.length; i++)
      expect(out.points[i]!.ts).toBeGreaterThan(out.points[i - 1]!.ts);
  });

  it("open interest history: columns [ts, open_interest, volume], interval + symbol", () => {
    const raw = loadFixture<{ columns: string[]; interval: string }>("strike-open-interest-history.json");
    expect(raw.columns).toEqual(["ts", "open_interest", "volume"]);
    const out = parseStrikeOpenInterestHistory(raw);
    expect(out.symbol).toBe("BTC-USD");
    expect(out.interval).toBe("10m");
    expect(out.points[1]).toEqual({ ts: 1788523200000, openInterest: 3.6932, volume: 0.06848 });
    expect(out.points[2]!.ts - out.points[1]!.ts).toBe(600_000);
  });

  it("premium index: string prices become numbers", () => {
    const out = parseStrikePremiumIndex(loadFixture("strike-premium-index.json"));
    expect(out.symbol).toBe("BTC-USD");
    expect(out.markPrice).toBeCloseTo(79739.86, 2);
    expect(out.indexPrice).toBeCloseTo(79738.92, 2);
    expect(out.fundingRate).toBeCloseTo(0.0000119369963994571, 12);
    expect(out.nextFundingTime).toBe(1788541200000);
    expect(out.time).toBe(1788540830809);
    expect(out.interestRate).toBe(0.0001);
  });

  it("rejects a row whose width disagrees with columns", () => {
    expect(() => parseStrikeFundingHistory({ columns: ["ts", "funding_rate"], data: [[1, 2, 3]] })).toThrow(
      /expected 2/,
    );
  });
});

describe("fetchStrike* request building", () => {
  it("klines: encodes params and clamps limit to 1500", async () => {
    const fetch = fakeFetch(() => [klineRow(0)]);
    await fetchStrikeKlines({
      fetch,
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "index",
      startTime: 5,
      endTime: 9,
      limit: 99_999,
    });
    const u = fetch.calls[0]!;
    expect(u.origin + u.pathname).toBe("https://api.strikefinance.org/price/v2/klines");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "index",
      startTime: "5",
      endTime: "9",
      limit: "1500",
    });
  });

  it("stats endpoints hit /stat/v1/stats/coin/history/* and premiumIndex hits /price/v2/premiumIndex", async () => {
    const fetch = fakeFetch((u) => {
      if (u.pathname.endsWith("/funding")) return loadFixture("strike-funding-history.json");
      if (u.pathname.endsWith("/open-interest")) return loadFixture("strike-open-interest-history.json");
      return loadFixture("strike-premium-index.json");
    });
    await fetchStrikeFundingHistory({ fetch, symbol: "BTC-USD", days: 90 });
    await fetchStrikeOpenInterestHistory({ fetch, symbol: "BTC-USD", interval: "1h" });
    await fetchStrikePremiumIndex({ fetch, symbol: "BTC-USD" });
    expect(fetch.calls.map((u) => u.pathname + u.search)).toEqual([
      "/stat/v1/stats/coin/history/funding?symbol=BTC-USD&days=90",
      "/stat/v1/stats/coin/history/open-interest?symbol=BTC-USD&interval=1h",
      "/price/v2/premiumIndex?symbol=BTC-USD",
    ]);
  });

  it("4xx surfaces as HttpError without retrying", async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: "symbol parameter is required" }, 400));
    await expect(fetchStrikeFundingHistory({ fetch, symbol: "", attempts: 3 })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(fetch.calls).toHaveLength(1);
  });

  it("5xx is retried up to `attempts`", async () => {
    let n = 0;
    const fetch = fakeFetch(() => (++n < 3 ? jsonResponse("boom", 503) : [klineRow(0)]));
    const out = await fetchStrikeKlines({
      fetch,
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "mark",
      attempts: 3,
    });
    expect(out).toHaveLength(1);
    expect(fetch.calls).toHaveLength(3);
  });
});

describe("backfillStrikeKlines pagination", () => {
  const T0 = Date.UTC(2026, 2, 20);
  const TOTAL = 3200; // > 2 full pages
  const server = fakeFetch((u) => {
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    const limit = Number(u.searchParams.get("limit"));
    const rows: unknown[][] = [];
    for (let t = Math.max(start, T0); t <= end && t < T0 + TOTAL * HOUR && rows.length < limit; t += HOUR)
      rows.push(klineRow(t));
    return rows;
  });

  it("walks forward in 1500-candle pages and stops on a short page", async () => {
    const out = await backfillStrikeKlines({
      fetch: server,
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "index",
      from: T0,
      to: T0 + 10_000 * HOUR,
    });
    expect(out).toHaveLength(TOTAL);
    expect(server.calls).toHaveLength(3);
    expect(server.calls.map((u) => Number(u.searchParams.get("startTime")))).toEqual([
      T0,
      T0 + 1500 * HOUR,
      T0 + 3000 * HOUR,
    ]);
    expect(server.calls.every((u) => u.searchParams.get("limit") === String(STRIKE_KLINES_MAX_LIMIT))).toBe(
      true,
    );
    expect(out[0]!.openTime).toBe(T0);
    expect(out[out.length - 1]!.openTime).toBe(T0 + (TOTAL - 1) * HOUR);
  });

  it("respects `to` and returns nothing past it", async () => {
    server.calls.length = 0;
    const out = await backfillStrikeKlines({
      fetch: server,
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "index",
      from: T0,
      to: T0 + 9 * HOUR,
    });
    expect(out.map((c) => c.openTime)).toEqual(Array.from({ length: 10 }, (_, i) => T0 + i * HOUR));
    expect(server.calls).toHaveLength(1);
  });

  it("stops when the server makes no forward progress", async () => {
    const stuck = fakeFetch(() => Array.from({ length: 1500 }, () => klineRow(T0)));
    const out = await backfillStrikeKlines({
      fetch: stuck,
      symbol: "BTC-USD",
      interval: "1h",
      priceType: "index",
      from: T0 + HOUR,
      to: T0 + 5000 * HOUR,
    });
    expect(stuck.calls).toHaveLength(1);
    expect(out).toHaveLength(0); // T0 is before `from`
  });
});
