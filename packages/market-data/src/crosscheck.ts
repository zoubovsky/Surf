import { pct, type Candle } from "@surf/core";

export type CrossCheckReason = "ok" | "no-secondary" | "bucket-mismatch" | "interval-mismatch" | "deviation-exceeded";

export interface CrossCheckResult {
  ok: boolean;
  /** Absolute close-to-close deviation in percent of the secondary close; null when not comparable. */
  deviationPct: number | null;
  reason: CrossCheckReason;
  primary: { venue: string; openTime: number; close: number } | null;
  secondary: { venue: string; openTime: number; close: number } | null;
}

function brief(c: Candle): { venue: string; openTime: number; close: number } {
  return { venue: c.venue, openTime: c.openTime, close: c.close };
}

/**
 * Compare the closes of the same candle bucket on two venues.
 * A missing secondary is reported as not ok (`no-secondary`) so the caller can decide whether to trade blind.
 */
export function crossCheck(primary: Candle, secondary: Candle | null, maxDeviationPct: number): CrossCheckResult {
  if (!secondary) {
    return { ok: false, deviationPct: null, reason: "no-secondary", primary: brief(primary), secondary: null };
  }
  const base = { primary: brief(primary), secondary: brief(secondary) };
  if (primary.interval !== secondary.interval) {
    return { ok: false, deviationPct: null, reason: "interval-mismatch", ...base };
  }
  if (primary.openTime !== secondary.openTime) {
    return { ok: false, deviationPct: null, reason: "bucket-mismatch", ...base };
  }
  const deviationPct = Math.abs(pct(primary.close, secondary.close));
  if (deviationPct > maxDeviationPct) {
    return { ok: false, deviationPct, reason: "deviation-exceeded", ...base };
  }
  return { ok: true, deviationPct, reason: "ok", ...base };
}

/**
 * Reference price for the risk engine's mark-vs-reference deviation gate.
 * Prefers the external venue (Coinbase latest closed 1h close); falls back to Strike's index (itself a
 * composite of external spot venues); null when neither is known. Non-positive inputs are treated as missing.
 */
export function referencePrice(coinbaseLatestClose: number | null, strikeIndex: number | null): number | null {
  if (coinbaseLatestClose !== null && Number.isFinite(coinbaseLatestClose) && coinbaseLatestClose > 0) {
    return coinbaseLatestClose;
  }
  if (strikeIndex !== null && Number.isFinite(strikeIndex) && strikeIndex > 0) return strikeIndex;
  return null;
}
