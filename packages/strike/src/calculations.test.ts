import { describe, expect, it } from "vitest";
import {
  BTC_USD_MARGIN_TIERS,
  calcLiquidationPriceCross,
  calcLiquidationPriceIsolated,
  calcMaintenanceMargin,
  calcMarginRatio,
  calcNotional,
  calcPositionSummary,
  calcTpSlPriceFromPercentage,
  calcTpSlPriceFromUsd,
  calcUnrealizedPnl,
  calcWithdrawableBalance,
  estimateFunding,
  getMarginTier,
  type MarginTier,
} from "./calculations.js";

/** Tier table from the strike-calculations skill usage example. */
const skillTiers: MarginTier[] = [
  { maxNotional: 50000, maxLeverage: 100, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 250000, maxLeverage: 50, maintenanceMarginRate: 0.005, maintenanceAmount: 50 },
  { maxNotional: 1000000, maxLeverage: 20, maintenanceMarginRate: 0.01, maintenanceAmount: 1300 },
  { maxNotional: 5000000, maxLeverage: 10, maintenanceMarginRate: 0.025, maintenanceAmount: 16300 },
  { maxNotional: 20000000, maxLeverage: 5, maintenanceMarginRate: 0.05, maintenanceAmount: 141300 },
];

describe("skill worked example (LONG isolated, entry 42000, mark 43500, size 0.5, 20x, iso 1050)", () => {
  const s = calcPositionSummary({
    direction: "long",
    marginMode: "isolated",
    entryPrice: 42000,
    markPrice: 43500,
    size: 0.5,
    leverage: 20,
    isoBalance: 1050,
    tiers: skillTiers,
  });
  it("notional, tier and margin", () => {
    expect(s.notional).toBe(21750);
    expect(s.tier).toBe(skillTiers[0]);
    expect(s.currentMargin).toBe(1050);
  });
  it("uPnL and PnL%", () => {
    expect(s.unrealizedPnl).toBe(750);
    expect(s.pnlPercentage).toBeCloseTo(71.4286, 3);
  });
  it("maintenance margin and liquidation price", () => {
    expect(s.maintenanceMargin).toBeCloseTo(87, 10);
    // (42000 - 1050/0.5) / (1 - 0.004) = 39900 / 0.996
    expect(s.liquidationPrice).toBeCloseTo(40060.241, 3);
    expect(s.marginRatio).toBeCloseTo(87 / (1050 + 750), 10);
  });
});

describe("margin tiers", () => {
  it("picks the first tier covering the notional, last tier as fallback", () => {
    expect(getMarginTier(skillTiers, 10_000)).toBe(skillTiers[0]);
    expect(getMarginTier(skillTiers, 50_000)).toBe(skillTiers[0]);
    expect(getMarginTier(skillTiers, 50_001)).toBe(skillTiers[1]);
    expect(getMarginTier(skillTiers, 1e9)).toBe(skillTiers[4]);
  });
  it("works with unsorted input and the live BTC table", () => {
    const shuffled = [...BTC_USD_MARGIN_TIERS].reverse();
    expect(getMarginTier(shuffled, 5_000).maxLeverage).toBe(100);
    expect(getMarginTier(BTC_USD_MARGIN_TIERS, 900_000)).toMatchObject({
      maintenanceMarginRate: 0.0065,
      maintenanceAmount: 1500,
    });
  });
});

describe("primitives", () => {
  it("notional uses absolute size", () => {
    expect(calcNotional(80_000, -0.01)).toBe(800);
  });
  it("uPnL sign follows direction", () => {
    expect(calcUnrealizedPnl("long", 80_000, 81_000, 0.1)).toBeCloseTo(100);
    expect(calcUnrealizedPnl("short", 80_000, 81_000, 0.1)).toBeCloseTo(-100);
    expect(calcUnrealizedPnl("short", 80_000, 79_000, -0.1)).toBeCloseTo(100);
  });
  it("maintenance margin subtracts the tier amount", () => {
    expect(calcMaintenanceMargin(900_000, BTC_USD_MARGIN_TIERS[6] as MarginTier)).toBeCloseTo(
      900_000 * 0.0065 - 1500,
    );
  });
  it("margin ratio handles zero/negative equity", () => {
    expect(calcMarginRatio(50, 100, -100)).toBe(Number.POSITIVE_INFINITY);
    expect(calcMarginRatio(0, 100, -100)).toBe(0);
    expect(calcMarginRatio(90, 100, 0)).toBeCloseTo(0.9);
  });
});

describe("isolated liquidation price", () => {
  const tier = BTC_USD_MARGIN_TIERS[0] as MarginTier;
  it("long: below entry; 5x isolated BTC example", () => {
    // 0.01 BTC @ 80000 = $800 notional, 5x -> iso 160. LP = (80000 - 160/0.01)/(0.996)
    const lp = calcLiquidationPriceIsolated("long", 80_000, 160, 0.01, tier);
    expect(lp).toBeCloseTo((80_000 - 16_000) / 0.996, 6);
    expect(lp).toBeLessThan(80_000);
  });
  it("short: above entry", () => {
    const lp = calcLiquidationPriceIsolated("short", 80_000, 160, 0.01, tier);
    expect(lp).toBeCloseTo((80_000 + 16_000) / 1.004, 6);
    expect(lp).toBeGreaterThan(80_000);
  });
  it("returns 0 when degenerate or immediately liquidatable", () => {
    expect(calcLiquidationPriceIsolated("long", 80_000, 0, 0, tier)).toBe(0);
    expect(calcLiquidationPriceIsolated("long", 80_000, -1000, 0.01, tier)).toBe(0);
    expect(calcLiquidationPriceIsolated("long", 100, 1_000_000, 0.01, tier)).toBe(0);
  });
});

describe("cross liquidation price", () => {
  const tier = skillTiers[0] as MarginTier;
  it("with no other positions equals the isolated formula with W as margin", () => {
    const cross = calcLiquidationPriceCross(
      { direction: "long", size: 0.5, entryPrice: 42_000, markPrice: 43_500, tier },
      1050,
      [],
      [],
    );
    expect(cross).toBeCloseTo(40060.241, 3);
  });
  it("short cross liquidation sits above entry", () => {
    const lp = calcLiquidationPriceCross(
      { direction: "short", size: 0.01, entryPrice: 80_000, markPrice: 80_000, tier },
      160,
      [],
      [],
    );
    expect(lp).toBeCloseTo((80_000 + 16_000) / 1.004, 6);
  });
  it("other positions' losses bring liquidation closer", () => {
    const base = calcLiquidationPriceCross(
      { direction: "long", size: 0.5, entryPrice: 42_000, markPrice: 43_500, tier },
      5000,
      [],
      [],
    );
    const withLoser = calcLiquidationPriceCross(
      { direction: "long", size: 0.5, entryPrice: 42_000, markPrice: 43_500, tier },
      5000,
      [{ direction: "long", size: 1, entryPrice: 3000, markPrice: 2500, tier }],
      [500],
    );
    expect(withLoser).toBeGreaterThan(base);
  });
});

describe("balances and targets", () => {
  it("withdrawable balance", () => {
    expect(
      calcWithdrawableBalance({
        walletBalance: 10_000,
        totalIsoBalance: 1_000,
        totalOrderCost: 500,
        crossInitialMargin: 2_000,
        crossUnrealizedPnl: -250,
        crossMaintenanceMargin: 400,
      }),
    ).toBe(10_000 - 1_000 - 500 - 2_250);
  });
  it("TP/SL price from ROI% and USD", () => {
    expect(calcTpSlPriceFromPercentage("long", 80_000, 50, 160, 0.01)).toBeCloseTo(88_000);
    expect(calcTpSlPriceFromPercentage("short", 80_000, 50, 160, 0.01)).toBeCloseTo(72_000);
    expect(calcTpSlPriceFromUsd("long", 80_000, 100, 0.01)).toBeCloseTo(90_000);
    expect(calcTpSlPriceFromUsd("short", 80_000, -100, 0.01)).toBeCloseTo(90_000);
  });
  it("funding estimate: positive rate means longs pay", () => {
    expect(estimateFunding("long", 10_000, 0.0001, 10)).toBeCloseTo(-10);
    expect(estimateFunding("short", 10_000, 0.0001, 10)).toBeCloseTo(10);
  });
});
