import type { Confidence } from "@surf/core";

export interface ClosedTradeLite {
  confidence: Confidence;
  setup: string | null;
  hadPrior: boolean;
  realizedR: number;
  outcome: "win" | "loss" | "scratch";
}

export interface BucketStats {
  n: number;
  winRate: number;
  avgR: number;
  expectancyR: number;
  brier: number | null;
}

export interface CalibrationSummary {
  totalTrades: number;
  byConfidence: Record<Confidence, BucketStats>;
  bySetup: Record<string, BucketStats>;
  withPrior: BucketStats;
  withoutPrior: BucketStats;
}

const IMPLIED_P: Record<Confidence, number> = { low: 0.4, medium: 0.55, high: 0.7 };

function stats(rows: ClosedTradeLite[], impliedP?: number): BucketStats {
  const n = rows.length;
  if (n === 0) return { n: 0, winRate: 0, avgR: 0, expectancyR: 0, brier: null };
  const wins = rows.filter((r) => r.outcome === "win").length;
  const avgR = rows.reduce((s, r) => s + r.realizedR, 0) / n;
  const brier =
    impliedP === undefined
      ? null
      : rows.reduce((s, r) => s + (impliedP - (r.outcome === "win" ? 1 : 0)) ** 2, 0) / n;
  return { n, winRate: wins / n, avgR, expectancyR: avgR, brier };
}

/** Calibration ledger from closed trades. Feeds the analyst as a compact table. */
export function summarizeCalibration(rows: ClosedTradeLite[]): CalibrationSummary {
  const byConfidence = {
    low: stats(
      rows.filter((r) => r.confidence === "low"),
      IMPLIED_P.low,
    ),
    medium: stats(
      rows.filter((r) => r.confidence === "medium"),
      IMPLIED_P.medium,
    ),
    high: stats(
      rows.filter((r) => r.confidence === "high"),
      IMPLIED_P.high,
    ),
  };
  const bySetup: Record<string, BucketStats> = {};
  for (const setup of new Set(rows.map((r) => r.setup ?? "unknown"))) {
    bySetup[setup] = stats(rows.filter((r) => (r.setup ?? "unknown") === setup));
  }
  return {
    totalTrades: rows.length,
    byConfidence,
    bySetup,
    withPrior: stats(rows.filter((r) => r.hadPrior)),
    withoutPrior: stats(rows.filter((r) => !r.hadPrior)),
  };
}

export function formatCalibrationForPrompt(c: CalibrationSummary): string {
  if (c.totalTrades === 0) return "No closed trades yet; no calibration data.";
  const line = (name: string, s: BucketStats) =>
    `${name}: n=${s.n} win=${(s.winRate * 100).toFixed(0)}% avgR=${s.avgR.toFixed(2)}${s.brier !== null ? ` brier=${s.brier.toFixed(2)}` : ""}`;
  const parts = [
    `total=${c.totalTrades}`,
    line("high", c.byConfidence.high),
    line("medium", c.byConfidence.medium),
    line("low", c.byConfidence.low),
    line("with-prior", c.withPrior),
    line("without-prior", c.withoutPrior),
    ...Object.entries(c.bySetup).map(([k, v]) => line(k, v)),
  ];
  return parts.join("\n");
}
