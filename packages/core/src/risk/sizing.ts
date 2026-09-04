import type { Direction } from "../schemas/common.js";

export interface SizingInput {
  equity: number;
  riskPct: number;
  entryPrice: number;
  stopLoss: number;
  direction: Direction;
  maxLeverage: number;
  sizeStep: number;
  minNotionalUsd: number;
}

export interface SizingResult {
  size: number;
  notionalUsd: number;
  leverage: number;
  marginUsd: number;
  riskUsd: number;
  stopDistance: number;
}

/** Round down to the venue step size, guarding floating error. */
export function roundToStep(value: number, step: number): number {
  const steps = Math.floor(value / step + 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((steps * step).toFixed(decimals));
}

export function roundToTick(price: number, tick: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

/**
 * Position size from fixed-fraction risk. Leverage is a consequence of size, capped.
 * If the risk-derived size would need more than maxLeverage, size is cut to the leverage cap
 * (so realised risk falls below target, never above).
 */
export function sizePosition(input: SizingInput): SizingResult | { error: string } {
  const { equity, riskPct, entryPrice, stopLoss, direction, maxLeverage, sizeStep, minNotionalUsd } = input;
  if (equity <= 0) return { error: "equity must be positive" };
  const stopDistance = direction === "long" ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (stopDistance <= 0) return { error: "stop must be on the losing side of entry" };
  const riskUsd = (equity * riskPct) / 100;
  let size = riskUsd / stopDistance;
  const maxNotional = equity * maxLeverage;
  if (size * entryPrice > maxNotional) size = maxNotional / entryPrice;
  size = roundToStep(size, sizeStep);
  const notionalUsd = size * entryPrice;
  if (size <= 0 || notionalUsd < minNotionalUsd)
    return { error: `notional ${notionalUsd.toFixed(2)} below minimum` };
  const leverage = Math.min(maxLeverage, Math.max(1, Math.ceil((notionalUsd / equity) * 100) / 100));
  return {
    size,
    notionalUsd,
    leverage,
    marginUsd: notionalUsd / leverage,
    riskUsd: size * stopDistance,
    stopDistance,
  };
}

/** Expected funding paid (positive = we pay) over a hold. Positive hourly rate means longs pay. */
export function expectedFundingUsd(
  notionalUsd: number,
  fundingRateHourly: number,
  holdHours: number,
  direction: Direction,
): number {
  const sign = direction === "long" ? 1 : -1;
  return sign * fundingRateHourly * notionalUsd * holdHours;
}
