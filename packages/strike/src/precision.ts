/**
 * Decimal formatting for wire values. Strike returns and expects decimal strings; sizes and prices
 * must be aligned to the symbol's step/tick and serialised with exactly that many decimals.
 *
 * BTC-USD (live exchangeInfo, 2026-09): tickSize 0.10, stepSize 0.00001, minNotional 10.
 */

export type RoundingMode = "floor" | "round" | "ceil";

/** Number of decimals implied by a step such as "0.00001" (5) or 0.1 (1). Integers give 0. */
export function decimalsFromStep(step: string | number): number {
  const s = typeof step === "number" ? stepToString(step) : step.trim();
  if (!/^\d*\.?\d+$/.test(s) || Number(s) <= 0) throw new RangeError(`invalid step: ${step}`);
  const dot = s.indexOf(".");
  if (dot === -1) return 0;
  return s.length - dot - 1 - trailingZeros(s.slice(dot + 1));
}

function trailingZeros(frac: string): number {
  let n = 0;
  for (let i = frac.length - 1; i >= 0 && frac[i] === "0"; i--) n++;
  return n;
}

/** Numeric step -> plain decimal string without exponent notation or float noise. */
function stepToString(step: number): string {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError(`invalid step: ${step}`);
  const s = String(step);
  if (!/e/i.test(s)) return s;
  const [mantissa = "", expStr = "0"] = s.split(/e/i);
  const exp = Number(expStr);
  const [intPart = "0", fracPart = ""] = mantissa.split(".");
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return "0." + "0".repeat(-pointPos) + digits;
  if (pointPos >= digits.length) return digits + "0".repeat(pointPos - digits.length);
  return digits.slice(0, pointPos) + "." + digits.slice(pointPos);
}

/**
 * Align `value` to a multiple of `step` and return it as a decimal string with the step's precision.
 * Uses a tiny epsilon so 0.1 + 0.2 style float noise does not flip a floor.
 */
export function formatToStep(value: number, step: string | number, mode: RoundingMode = "round"): string {
  if (!Number.isFinite(value)) throw new RangeError(`cannot format non-finite value: ${value}`);
  const decimals = decimalsFromStep(step);
  const stepNum = Number(step);
  const ratio = value / stepNum;
  const eps = 1e-9;
  let units: number;
  if (mode === "floor") units = Math.floor(ratio + eps);
  else if (mode === "ceil") units = Math.ceil(ratio - eps);
  else units = Math.round(ratio);
  const aligned = units * stepNum;
  const out = aligned.toFixed(decimals);
  return out === "-0" || /^-0\.0*$/.test(out) ? (0).toFixed(decimals) : out;
}

/** Sizes are floored so we never exceed what the risk engine allowed. Default step is BTC-USD. */
export function formatSize(size: number, stepSize: string | number = "0.00001"): string {
  return formatToStep(Math.abs(size), stepSize, "floor");
}

/** Prices are rounded to the tick. Default tick is BTC-USD. */
export function formatPrice(
  price: number,
  tickSize: string | number = "0.1",
  mode: RoundingMode = "round",
): string {
  return formatToStep(price, tickSize, mode);
}

/**
 * Strike rejects limit orders further than `bound` (fraction, e.g. 0.05) from the mark price.
 * Returns true when `price` is acceptable.
 */
export function isWithinPriceBound(price: number, markPrice: number, bound: number): boolean {
  if (!(markPrice > 0) || !(price > 0)) return false;
  return Math.abs(price - markPrice) / markPrice <= bound + 1e-12;
}

/** Nearest acceptable price inside the bound (clamped toward mark) for the given side of the book. */
export function clampToPriceBound(price: number, markPrice: number, bound: number): number {
  const lo = markPrice * (1 - bound);
  const hi = markPrice * (1 + bound);
  return Math.min(hi, Math.max(lo, price));
}
