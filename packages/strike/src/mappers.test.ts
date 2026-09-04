import { describe, expect, it } from "vitest";
import { depthNotionalWithin, toAccountSnapshot, toMarketSnapshot } from "./mappers.js";
import {
  DepthSchema,
  PremiumIndexSchema,
  PositionsResponseSchema,
  StrikeAccountSchema,
  BookTickerSchema,
  quoteBigIds,
} from "./schemas.js";
import {
  accountFixture,
  bookTickerFixture,
  depthFixtureText,
  positionsFixture,
  premiumIndexFixture,
} from "./fixtures/index.js";

const account = StrikeAccountSchema.parse(accountFixture);
const positions = PositionsResponseSchema.parse(positionsFixture);
const premiumIndex = PremiumIndexSchema.parse(premiumIndexFixture);
const bookTicker = BookTickerSchema.parse(bookTickerFixture);
const depth = DepthSchema.parse(JSON.parse(quoteBigIds(depthFixtureText)));

describe("toAccountSnapshot", () => {
  it("maps equity, available balance and positions with direction from size sign", () => {
    const snap = toAccountSnapshot(account, positions, { openOrders: 2, asOf: 1_788_540_000_000 });
    expect(snap.asOf).toBe(1_788_540_000_000);
    expect(snap.equity).toBe(10250.5);
    expect(snap.availableBalance).toBe(7500);
    expect(snap.openOrders).toBe(2);
    expect(snap.openPositions).toEqual([
      {
        symbol: "BTC-USD",
        direction: "long",
        size: 0.5,
        entryPrice: 50000,
        leverage: 5,
        liquidationPrice: 45500,
        unrealizedPnl: 250.5,
      },
      {
        symbol: "ETH-USD",
        direction: "short",
        size: 2,
        entryPrice: 3000,
        leverage: 10,
        liquidationPrice: null,
        unrealizedPnl: -40,
      },
    ]);
  });
  it("accepts the open orders array and drops flat positions", () => {
    const flat = { ...positions[0]!, size: 0, direction: null };
    const snap = toAccountSnapshot(account, [flat], { openOrders: [] as never[] });
    expect(snap.openPositions).toEqual([]);
    expect(snap.openOrders).toBe(0);
    expect(snap.asOf).toBeGreaterThan(0);
  });
});

describe("depthNotionalWithin", () => {
  it("sums price*qty inside the band on one side", () => {
    const asks = [
      { price: 100, qty: 1 },
      { price: 100.4, qty: 2 },
      { price: 100.6, qty: 5 },
    ];
    expect(depthNotionalWithin(asks, 100, 0.005, "asks")).toBeCloseTo(100 + 200.8);
    const bids = [
      { price: 99.9, qty: 1 },
      { price: 99.4, qty: 3 },
    ];
    expect(depthNotionalWithin(bids, 100, 0.005, "bids")).toBeCloseTo(99.9);
  });
});

describe("toMarketSnapshot", () => {
  const mid = (79808.8 + 79810.4) / 2;
  const asksNear = depth.asks.filter((l) => l.price <= mid * 1.005).reduce((s, l) => s + l.price * l.qty, 0);
  const bidsNear = depth.bids.filter((l) => l.price >= mid * 0.995).reduce((s, l) => s + l.price * l.qty, 0);

  it("uses ask-side depth for a long, bid-side for a short, the thinner side otherwise", () => {
    const base = {
      premiumIndex,
      bookTicker,
      depth,
      referencePrice: 79_790,
      lastCandleCloseTime: 1788537599999,
    };
    const long = toMarketSnapshot({ ...base, direction: "long" });
    const short = toMarketSnapshot({ ...base, direction: "short" });
    const none = toMarketSnapshot(base);
    expect(long.depthNotionalNear).toBeCloseTo(asksNear, 6);
    expect(short.depthNotionalNear).toBeCloseTo(bidsNear, 6);
    expect(none.depthNotionalNear).toBeCloseTo(Math.min(asksNear, bidsNear), 6);
    // The far levels (79300 / 80300) are outside 0.5% and excluded.
    expect(asksNear).toBeLessThan(depth.asks.reduce((s, l) => s + l.price * l.qty, 0));
  });

  it("carries mark/index/funding/best quotes and validates against the core schema", () => {
    const snap = toMarketSnapshot({
      premiumIndex,
      bookTicker,
      depth,
      referencePrice: null,
      lastCandleCloseTime: null,
      asOf: 1,
    });
    expect(snap).toMatchObject({
      asOf: 1,
      symbol: "BTC-USD",
      markPrice: premiumIndex.markPrice,
      indexPrice: premiumIndex.indexPrice,
      referencePrice: null,
      bestBid: 79808.8,
      bestAsk: 79810.4,
      fundingRateHourly: 0.0000118475870710157,
      nextFundingTime: 1788541200000,
      lastCandleCloseTime: null,
    });
  });

  it("falls back to top-of-book from depth and to null depth", () => {
    const snap = toMarketSnapshot({ premiumIndex, depth, referencePrice: 1, lastCandleCloseTime: 1 });
    expect(snap.bestBid).toBe(79765.7);
    expect(snap.bestAsk).toBe(79769.5);
    expect(snap.asOf).toBe(premiumIndex.time);
    const noDepth = toMarketSnapshot({ premiumIndex, referencePrice: 1, lastCandleCloseTime: 1 });
    expect(noDepth.bestBid).toBeNull();
    expect(noDepth.depthNotionalNear).toBeNull();
  });
});
