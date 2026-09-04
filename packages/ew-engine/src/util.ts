import type { PriceZone } from "@surf/core";

/** Index access that narrows away `undefined` under `noUncheckedIndexedAccess`. */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range (length ${arr.length})`);
  return v;
}

export function last<T>(arr: readonly T[]): T {
  return at(arr, arr.length - 1);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Sign of a non-zero move as +1/-1. Zero maps to +1 so callers never see 0. */
export function sgn(x: number): 1 | -1 {
  return x < 0 ? -1 : 1;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Build a zone from two prices in any order. Prices are rounded to 6 decimals. */
export function zone(a: number, b: number, label: string): PriceZone {
  const lo = round(Math.min(a, b));
  const hi = round(Math.max(a, b));
  return { low: lo, high: hi, label: truncate(label, 120) };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const abs = Math.abs(x);
  if (abs >= 1000) return x.toFixed(0);
  if (abs >= 10) return x.toFixed(2);
  return x.toFixed(4);
}

export function pctStr(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
