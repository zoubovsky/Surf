/**
 * Live smoke test against mainnet public endpoints. Skipped unless STRIKE_LIVE_TESTS=1.
 * Never touches authenticated endpoints.
 */
import { describe, expect, it } from "vitest";
import { toMarketSnapshot } from "./mappers.js";
import { StrikeRestClient } from "./rest.js";
import { StrikePublicStream } from "./ws-public.js";
import type { MarkPriceUpdate } from "./schemas.js";

const LIVE = process.env["STRIKE_LIVE_TESTS"] === "1";

describe.skipIf(!LIVE)("live mainnet (public endpoints)", () => {
  const client = new StrikeRestClient();

  it("exchangeInfo lists BTC-USD with the expected rules", async () => {
    const info = await client.exchangeInfo();
    const btc = info.symbols.find((s) => s.symbol === "BTC-USD");
    expect(btc).toBeDefined();
    expect(btc!.rules.tickSize).toBe(0.1);
    expect(btc!.rules.stepSize).toBe(0.00001);
    expect(btc!.rules.minNotional).toBe(10);
    expect(btc!.rules.limitTakeBound).toBe(0.05);
    expect(info.rateLimits.length).toBeGreaterThan(0);
  });

  it("premiumIndex returns mark/index/funding", async () => {
    const pi = await client.premiumIndex("BTC-USD");
    expect(pi.symbol).toBe("BTC-USD");
    expect(pi.markPrice).toBeGreaterThan(1000);
    expect(Math.abs(pi.indexPrice / pi.markPrice - 1)).toBeLessThan(0.01);
    expect(Math.abs(pi.fundingRate)).toBeLessThan(0.005);
    expect(pi.nextFundingTime).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it("klines 1h limit 5 map to Candle[]", async () => {
    const candles = await client.klines({ symbol: "BTC-USD", interval: "1h", priceType: "index", limit: 5 });
    expect(candles).toHaveLength(5);
    for (const c of candles) {
      expect(c.venue).toBe("strike");
      expect(c.closeTime - c.openTime).toBe(3_600_000 - 1);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    for (let i = 1; i < candles.length; i++)
      expect(candles[i]!.openTime - candles[i - 1]!.openTime).toBe(3_600_000);
  });

  it("depth, bookTicker, openInterest, market, feeTiers parse", async () => {
    const [depth, book, oi, market, fees] = await Promise.all([
      client.depth("BTC-USD", 20),
      client.bookTicker("BTC-USD"),
      client.openInterest("BTC-USD"),
      client.market("BTC-USD"),
      client.feeTiers(),
    ]);
    expect(typeof depth.lastUpdateId).toBe("bigint");
    expect(depth.bids.length).toBeGreaterThan(0);
    expect(depth.asks.length).toBeGreaterThan(0);
    expect(depth.bids[0]!.price).toBeLessThan(depth.asks[0]!.price);
    expect(book.bidPrice).not.toBeNull();
    expect(oi.openInterest).toBeGreaterThan(0);
    expect(market.limitTakeBound).toBe(0.05);
    expect(market.marginTiers.length).toBeGreaterThan(5);
    expect(market.marginTiers[0]!.maxLeverage).toBe(100);
    expect(fees.feeTiers[0]!.takerRate).toBe(0.0005);
    expect(fees.feeTiers[0]!.makerRate).toBeLessThan(0);
  });

  it("composes a MarketSnapshot from live data", async () => {
    const [pi, book, depth] = await Promise.all([
      client.premiumIndex("BTC-USD"),
      client.bookTicker("BTC-USD"),
      client.depth("BTC-USD", 100),
    ]);
    const snap = toMarketSnapshot({
      premiumIndex: pi,
      bookTicker: book,
      depth,
      referencePrice: null,
      lastCandleCloseTime: null,
      direction: "long",
    });
    expect(snap.depthNotionalNear).toBeGreaterThan(0);
    expect(snap.bestBid!).toBeLessThan(snap.bestAsk!);
  });

  it("public WebSocket delivers a markPriceUpdate", async () => {
    const stream = new StrikePublicStream();
    stream.subscribeMarkPrice("BTC-USD");
    const ev = await new Promise<MarkPriceUpdate>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no markPriceUpdate within 15s")), 15_000);
      stream.on("markPrice", (m) => {
        clearTimeout(t);
        resolve(m);
      });
      stream.on("error", reject);
      stream.connect();
    }).finally(() => stream.close());
    expect(ev.symbol).toBe("BTC-USD");
    expect(ev.markPrice).toBeGreaterThan(1000);
  });
});
