/**
 * Map Strike responses onto the core contracts (`AccountSnapshot`, `MarketSnapshot`).
 * Output is validated against the core Zod schemas so downstream code can trust it.
 */
import { AccountSnapshot, MarketSnapshot } from "@surf/core";
import type { Direction } from "@surf/core";
import type {
  BookTicker,
  Depth,
  PremiumIndex,
  StrikeAccount,
  StrikeOrder,
  StrikePosition,
} from "./schemas.js";

export interface AccountSnapshotOptions {
  /** Open order count or the open orders themselves. Defaults to 0 when unknown. */
  openOrders?: number | readonly StrikeOrder[] | undefined;
  asOf?: number | undefined;
}

/**
 * Equity is `marginBalance` (wallet + unrealised PnL). Positions with size 0 are dropped; direction
 * comes from the sign of `size`; a zero liquidation price becomes null.
 */
export function toAccountSnapshot(
  account: StrikeAccount,
  positions: readonly StrikePosition[],
  opts: AccountSnapshotOptions = {},
): AccountSnapshot {
  const openOrders = typeof opts.openOrders === "number" ? opts.openOrders : (opts.openOrders?.length ?? 0);
  return AccountSnapshot.parse({
    asOf: opts.asOf ?? Date.now(),
    equity: Math.max(0, account.marginBalance),
    availableBalance: Math.max(0, account.availableBalance),
    openPositions: positions
      .filter((p) => p.size !== 0)
      .map((p) => ({
        symbol: p.symbol,
        direction: (p.size > 0 ? "long" : "short") as Direction,
        size: Math.abs(p.size),
        entryPrice: p.entryPrice,
        leverage: p.leverage > 0 ? p.leverage : 1,
        liquidationPrice: p.liquidationPrice !== null && p.liquidationPrice > 0 ? p.liquidationPrice : null,
        unrealizedPnl: p.unrealizedPnl,
      })),
    openOrders,
  });
}

/** Notional (USD) resting within `band` (fraction) of `mid` on one side of the book. */
export function depthNotionalWithin(
  levels: readonly { price: number; qty: number }[],
  mid: number,
  band: number,
  side: "bids" | "asks",
): number {
  let total = 0;
  for (const l of levels) {
    const inBand = side === "asks" ? l.price <= mid * (1 + band) : l.price >= mid * (1 - band);
    if (!inBand) continue;
    total += l.price * l.qty;
  }
  return total;
}

export interface MarketSnapshotInput {
  premiumIndex: PremiumIndex;
  bookTicker?: BookTicker | null | undefined;
  depth?: Depth | null | undefined;
  /** Second-venue price for the reference-deviation check; null when unavailable. */
  referencePrice: number | null;
  lastCandleCloseTime: number | null;
  /** Side we would take: long hits asks, short hits bids. Omit for the thinner side. */
  direction?: Direction | null | undefined;
  /** Band around mid for `depthNotionalNear`; default 0.5%. */
  depthBand?: number | undefined;
  asOf?: number | undefined;
}

export function toMarketSnapshot(input: MarketSnapshotInput): MarketSnapshot {
  const { premiumIndex: pi } = input;
  const book = input.bookTicker ?? null;
  const depth = input.depth ?? null;
  const topBid = depth?.bids[0]?.price ?? null;
  const topAsk = depth?.asks[0]?.price ?? null;
  const bestBid = book?.bidPrice ?? topBid;
  const bestAsk = book?.askPrice ?? topAsk;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : pi.markPrice;
  const band = input.depthBand ?? 0.005;

  let depthNotionalNear: number | null = null;
  if (depth) {
    const askSide = depthNotionalWithin(depth.asks, mid, band, "asks");
    const bidSide = depthNotionalWithin(depth.bids, mid, band, "bids");
    if (input.direction === "long") depthNotionalNear = askSide;
    else if (input.direction === "short") depthNotionalNear = bidSide;
    else depthNotionalNear = Math.min(askSide, bidSide);
  }

  return MarketSnapshot.parse({
    asOf: input.asOf ?? pi.time,
    symbol: pi.symbol,
    markPrice: pi.markPrice,
    indexPrice: pi.indexPrice,
    referencePrice: input.referencePrice,
    bestBid,
    bestAsk,
    depthNotionalNear,
    // Strike funding settles hourly; premiumIndex.fundingRate is already the per-hour rate.
    fundingRateHourly: pi.fundingRate,
    nextFundingTime: pi.nextFundingTime,
    lastCandleCloseTime: input.lastCandleCloseTime,
  });
}
