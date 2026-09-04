/**
 * Position arithmetic per the official strike-calculations skill. Pure functions; no I/O.
 * Directions use the core `Direction` ("long" | "short"); position size is unsigned here.
 */
import type { Direction } from "@surf/core";
import type { MarginTier } from "./schemas.js";

export type { MarginTier } from "./schemas.js";

/**
 * BTC-USD margin tiers as served by `/v2/markets/BTC-USD` on 2026-09-04. Fallback for offline
 * calculations; prefer the live `StrikeMarket.marginTiers`.
 */
export const BTC_USD_MARGIN_TIERS: readonly MarginTier[] = [
  { maxNotional: 10_000, maxLeverage: 100, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 50_000, maxLeverage: 75, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 100_000, maxLeverage: 50, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 250_000, maxLeverage: 40, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 300_000, maxLeverage: 25, maintenanceMarginRate: 0.004, maintenanceAmount: 0 },
  { maxNotional: 800_000, maxLeverage: 25, maintenanceMarginRate: 0.005, maintenanceAmount: 300 },
  { maxNotional: 1_000_000, maxLeverage: 25, maintenanceMarginRate: 0.0065, maintenanceAmount: 1_500 },
  { maxNotional: 2_500_000, maxLeverage: 20, maintenanceMarginRate: 0.0065, maintenanceAmount: 1_500 },
  { maxNotional: 3_000_000, maxLeverage: 10, maintenanceMarginRate: 0.0065, maintenanceAmount: 1_500 },
  { maxNotional: 10_000_000, maxLeverage: 10, maintenanceMarginRate: 0.01, maintenanceAmount: 12_000 },
  { maxNotional: 12_000_000, maxLeverage: 5, maintenanceMarginRate: 0.01, maintenanceAmount: 12_000 },
  { maxNotional: 25_000_000, maxLeverage: 5, maintenanceMarginRate: 0.02, maintenanceAmount: 132_000 },
  { maxNotional: 70_000_000, maxLeverage: 1, maintenanceMarginRate: 0.02, maintenanceAmount: 132_000 },
  { maxNotional: 100_000_000, maxLeverage: 1, maintenanceMarginRate: 0.025, maintenanceAmount: 482_000 },
];

const dir = (d: Direction): 1 | -1 => (d === "long" ? 1 : -1);

/** Tier whose maxNotional covers the notional; the last tier when nothing does. */
export function getMarginTier(tiers: readonly MarginTier[], notional: number): MarginTier {
  if (tiers.length === 0) throw new RangeError("no margin tiers");
  const sorted = [...tiers].sort((a, b) => a.maxNotional - b.maxNotional);
  return sorted.find((t) => notional <= t.maxNotional) ?? (sorted[sorted.length - 1] as MarginTier);
}

/** Notional = mark * |size|. */
export function calcNotional(markPrice: number, size: number): number {
  return markPrice * Math.abs(size);
}

/** LONG: (mark - entry) * size; SHORT: (entry - mark) * size. */
export function calcUnrealizedPnl(
  direction: Direction,
  entryPrice: number,
  markPrice: number,
  size: number,
): number {
  return dir(direction) * (markPrice - entryPrice) * Math.abs(size);
}

export function calcPnlPercentage(unrealizedPnl: number, currentMargin: number): number {
  return currentMargin === 0 ? 0 : (unrealizedPnl / currentMargin) * 100;
}

/** Isolated: the isolated balance. Cross: notional / leverage. */
export function calcCurrentMargin(
  marginMode: "cross" | "isolated",
  isoBalance: number,
  notional: number,
  leverage: number,
): number {
  if (marginMode === "isolated") return isoBalance;
  return leverage > 0 ? notional / leverage : 0;
}

/** MM = notional * MMR - maintenanceAmount. */
export function calcMaintenanceMargin(notional: number, tier: MarginTier): number {
  return notional * tier.maintenanceMarginRate - tier.maintenanceAmount;
}

/**
 * Margin ratio as used by the liquidation engine: maintenance margin / (balance + uPnL).
 * >= 0.7 margin call, >= 0.9 reduce-only, >= 1.0 liquidation. Infinity when equity <= 0.
 */
export function calcMarginRatio(maintenanceMargin: number, balance: number, unrealizedPnl: number): number {
  const equity = balance + unrealizedPnl;
  if (equity <= 0) return maintenanceMargin > 0 ? Number.POSITIVE_INFINITY : 0;
  return maintenanceMargin / equity;
}

/**
 * Isolated liquidation price (fixed for the life of the position):
 *   LP = (EP - (isoBalance + MA) / signedSize) / (1 - dir * MMR)
 * where signedSize is negative for shorts (so a short's LP sits above entry).
 * Returns 0 when the position would be liquidated immediately or the formula is degenerate.
 */
export function calcLiquidationPriceIsolated(
  direction: Direction,
  entryPrice: number,
  isoBalance: number,
  size: number,
  tier: MarginTier,
): number {
  const signedSize = dir(direction) * Math.abs(size);
  if (signedSize === 0) return 0;
  const denominator = 1 - dir(direction) * tier.maintenanceMarginRate;
  if (denominator === 0) return 0;
  const lp = (entryPrice - (isoBalance + tier.maintenanceAmount) / signedSize) / denominator;
  if (lp <= 0) return 0;
  if (direction === "long" && lp >= entryPrice) return 0;
  if (direction === "short" && lp <= entryPrice) return 0;
  return lp;
}

export interface CrossPositionInput {
  direction: Direction;
  size: number;
  entryPrice: number;
  markPrice: number;
  tier: MarginTier;
}

/**
 * Cross liquidation price (moves with wallet balance and other positions):
 *   LP = (EP - (W + TU - TM + MA) / signedSize) / (1 - dir * MMR)
 * W = wallet balance minus isolated balances; TU/TM = other cross positions' uPnL / maintenance margin;
 * signedSize is negative for shorts.
 */
export function calcLiquidationPriceCross(
  position: CrossPositionInput,
  walletBalance: number,
  otherCrossPositions: readonly CrossPositionInput[],
  isolatedBalances: readonly number[],
): number {
  const signedSize = dir(position.direction) * Math.abs(position.size);
  if (signedSize === 0) return 0;
  const W = walletBalance - isolatedBalances.reduce((s, b) => s + b, 0);
  const TU = otherCrossPositions.reduce(
    (s, p) => s + calcUnrealizedPnl(p.direction, p.entryPrice, p.markPrice, p.size),
    0,
  );
  const TM = otherCrossPositions.reduce(
    (s, p) => s + calcMaintenanceMargin(calcNotional(p.markPrice, p.size), p.tier),
    0,
  );
  const denominator = 1 - dir(position.direction) * position.tier.maintenanceMarginRate;
  if (denominator === 0) return 0;
  const lp =
    (position.entryPrice - (W + TU - TM + position.tier.maintenanceAmount) / signedSize) / denominator;
  if (lp <= 0) return 0;
  if (position.direction === "long" && lp >= position.entryPrice) return 0;
  if (position.direction === "short" && lp <= position.entryPrice) return 0;
  return lp;
}

/** max(0, base - max(crossIM - crossUPnL, crossMM)); base = wallet - isolated balances - order costs. */
export function calcWithdrawableBalance(args: {
  walletBalance: number;
  totalIsoBalance: number;
  totalOrderCost: number;
  crossInitialMargin: number;
  crossUnrealizedPnl: number;
  crossMaintenanceMargin: number;
}): number {
  const base = args.walletBalance - args.totalIsoBalance - args.totalOrderCost;
  const requirement = Math.max(
    args.crossInitialMargin - args.crossUnrealizedPnl,
    args.crossMaintenanceMargin,
  );
  return Math.max(0, base - requirement);
}

/** Price at which ROI on margin equals `percentage` (e.g. 50 = +50%). */
export function calcTpSlPriceFromPercentage(
  direction: Direction,
  entryPrice: number,
  percentage: number,
  margin: number,
  size: number,
): number {
  const offset = ((percentage / 100) * margin) / Math.abs(size);
  return entryPrice + dir(direction) * offset;
}

/** Price at which PnL equals `usdGain` (negative for a loss). */
export function calcTpSlPriceFromUsd(
  direction: Direction,
  entryPrice: number,
  usdGain: number,
  size: number,
): number {
  return entryPrice + (dir(direction) * usdGain) / Math.abs(size);
}

export interface PositionSummary {
  notional: number;
  tier: MarginTier;
  unrealizedPnl: number;
  pnlPercentage: number;
  currentMargin: number;
  maintenanceMargin: number;
  marginRatio: number;
  liquidationPrice: number;
}

export function calcPositionSummary(args: {
  direction: Direction;
  marginMode: "cross" | "isolated";
  entryPrice: number;
  markPrice: number;
  size: number;
  leverage: number;
  isoBalance: number;
  tiers: readonly MarginTier[];
  walletBalance?: number | undefined;
  otherCrossPositions?: readonly CrossPositionInput[] | undefined;
  isolatedBalances?: readonly number[] | undefined;
}): PositionSummary {
  const notional = calcNotional(args.markPrice, args.size);
  const tier = getMarginTier(args.tiers, notional);
  const unrealizedPnl = calcUnrealizedPnl(args.direction, args.entryPrice, args.markPrice, args.size);
  const currentMargin = calcCurrentMargin(args.marginMode, args.isoBalance, notional, args.leverage);
  const maintenanceMargin = calcMaintenanceMargin(notional, tier);
  const liquidationPrice =
    args.marginMode === "isolated"
      ? calcLiquidationPriceIsolated(args.direction, args.entryPrice, args.isoBalance, args.size, tier)
      : calcLiquidationPriceCross(
          {
            direction: args.direction,
            size: args.size,
            entryPrice: args.entryPrice,
            markPrice: args.markPrice,
            tier,
          },
          args.walletBalance ?? 0,
          args.otherCrossPositions ?? [],
          args.isolatedBalances ?? [],
        );
  const balance = args.marginMode === "isolated" ? args.isoBalance : (args.walletBalance ?? currentMargin);
  return {
    notional,
    tier,
    unrealizedPnl,
    pnlPercentage: calcPnlPercentage(unrealizedPnl, currentMargin),
    currentMargin,
    maintenanceMargin,
    marginRatio: calcMarginRatio(maintenanceMargin, balance, unrealizedPnl),
    liquidationPrice,
  };
}

/** Funding paid (negative) or received over `hours` at a constant hourly rate for a position. */
export function estimateFunding(
  direction: Direction,
  notional: number,
  hourlyRate: number,
  hours: number,
): number {
  // Positive rate: longs pay shorts.
  return -dir(direction) * hourlyRate * notional * hours;
}
