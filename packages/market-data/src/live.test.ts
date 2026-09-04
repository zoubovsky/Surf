/**
 * Live smoke test against the real venues. Skipped unless MARKET_LIVE_TESTS=1:
 *   MARKET_LIVE_TESTS=1 pnpm exec vitest run packages/market-data/src/live.test.ts
 */
import { describe, expect, it } from "vitest";
import { crossCheck } from "./crosscheck.js";
import { fetchCoinbaseCandles } from "./sources/coinbase.js";
import { fetchStrikeFundingHistory, fetchStrikeKlines, fetchStrikeOpenInterestHistory, fetchStrikePremiumIndex } from "./sources/strike.js";

const live = process.env["MARKET_LIVE_TESTS"] === "1";

describe.skipIf(!live)("live market data (MARKET_LIVE_TESTS=1)", () => {
  it("Strike index 1h and Coinbase 1h overlap within 1%", async () => {
    const strike = await fetchStrikeKlines({ fetch, symbol: "BTC-USD", interval: "1h", priceType: "index", limit: 5 });
    const coinbase = await fetchCoinbaseCandles({ fetch, product: "BTC-USD", granularity: 3600 });
    expect(strike.length).toBeGreaterThanOrEqual(3);
    expect(coinbase.length).toBeGreaterThan(5);
    const byOpen = new Map(coinbase.map((c) => [c.openTime, c]));
    let compared = 0;
    for (const s of strike) {
      const c = byOpen.get(s.openTime);
      if (!c) continue;
      const res = crossCheck(s, c, 1);
      expect(res, `bucket ${new Date(s.openTime).toISOString()} deviates ${res.deviationPct}%`).toMatchObject({ ok: true });
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(3);
  });

  it("Strike stats endpoints respond with the documented column layouts", async () => {
    const funding = await fetchStrikeFundingHistory({ fetch, symbol: "BTC-USD" });
    expect(funding.symbol).toBe("BTC-USD");
    expect(funding.points.length).toBeGreaterThan(100);
    const oi = await fetchStrikeOpenInterestHistory({ fetch, symbol: "BTC-USD", interval: "1h" });
    expect(oi.interval).toBe("1h");
    expect(oi.points.length).toBeGreaterThan(5);
    const premium = await fetchStrikePremiumIndex({ fetch, symbol: "BTC-USD" });
    expect(premium.markPrice).toBeGreaterThan(1000);
    expect(premium.nextFundingTime).toBeGreaterThan(Date.now() - 3_600_000);
  });
});
