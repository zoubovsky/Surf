import type { Direction, PriceZone } from "@surf/core";

export const HEARTBEAT_ANALYSIS_HOURS = 6;
export const ENTRY_ZONE_PROXIMITY_PCT = 0.5;

export interface TopCandidateRef {
  id: string;
  position: string;
}

export interface PregateInput {
  kind: "hourly" | "video";
  hasOpenPosition: boolean;
  /** Direction of the open position, for the adverse-funding test. */
  openDirection: Direction | null;
  hasRestingOrder: boolean;
  topCandidate: TopCandidateRef | null;
  lastTopCandidate: TopCandidateRef | null;
  price: number;
  /** Entry zones of the top-3 1h candidates (nulls already dropped). */
  entryZones: PriceZone[];
  /** A new analyst prior was stored since the last cycle. */
  newSignal: boolean;
  fundingRateHourly: number;
  maxAdverseFundingHourly: number;
  lastLlmCycleAt: number | null;
  now: number;
}

export interface PregateResult {
  run: boolean;
  reasons: string[];
}

/** True when `price` is inside `zone` or within `pct` percent of either edge. */
export function nearZone(price: number, zone: PriceZone, pct = ENTRY_ZONE_PROXIMITY_PCT): boolean {
  const lo = Math.min(zone.low, zone.high);
  const hi = Math.max(zone.low, zone.high);
  const band = (price * pct) / 100;
  return price >= lo - band && price <= hi + band;
}

/**
 * Deterministic cost control for Loop B. The LLM stages run only when something is worth looking
 * at; otherwise the cycle ends `no-op` for free. Pure so every trigger is unit-testable.
 */
export function pregate(i: PregateInput): PregateResult {
  const reasons: string[] = [];
  if (i.kind === "video") reasons.push("new video signal triggered the cycle");
  if (i.hasOpenPosition) reasons.push("position open");
  if (i.hasRestingOrder) reasons.push("resting order exists");
  if (i.topCandidate && (!i.lastTopCandidate || i.lastTopCandidate.id !== i.topCandidate.id))
    reasons.push(`top 1h candidate changed to ${i.topCandidate.id}`);
  else if (i.topCandidate && i.lastTopCandidate && i.lastTopCandidate.position !== i.topCandidate.position)
    reasons.push(`top 1h candidate moved to ${i.topCandidate.position}`);
  const zone = i.entryZones.find((z) => nearZone(i.price, z));
  if (zone) reasons.push(`price ${i.price} near entry zone ${zone.low}-${zone.high}`);
  if (i.newSignal) reasons.push("new analyst prior since last cycle");
  const adverse =
    i.openDirection === "long"
      ? i.fundingRateHourly
      : i.openDirection === "short"
        ? -i.fundingRateHourly
        : Math.abs(i.fundingRateHourly);
  if (adverse > i.maxAdverseFundingHourly)
    reasons.push(`adverse funding ${(adverse * 100).toFixed(4)}%/h beyond limit`);
  if (i.lastLlmCycleAt === null || i.now - i.lastLlmCycleAt >= HEARTBEAT_ANALYSIS_HOURS * 3_600_000)
    reasons.push(`heartbeat analysis (${HEARTBEAT_ANALYSIS_HOURS}h+ since last LLM cycle)`);
  return { run: reasons.length > 0, reasons };
}
