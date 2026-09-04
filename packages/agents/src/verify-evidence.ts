import type { AnalystPrior, Confidence, PriceLevel } from "@surf/core";
import { UnsupportedPriorError } from "./errors.js";
import type { EvidenceReport } from "./types.js";

/** Case/whitespace/quote-insensitive form used for substring matching. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function trimDecimals(n: number, places: number): string {
  return n.toFixed(places).replace(/\.?0+$/, "");
}

/**
 * Spoken/written forms a price may take in an auto-caption transcript:
 * 79000 -> "79000", "79,000", "79 000", "79k", "79 k", "79 thousand"; 79500 -> "79.5k" too.
 * Returned as regex sources (already escaped).
 */
export function numberForms(price: number): string[] {
  const forms = new Set<string>();
  const rounded = Math.round(price);
  const intStr = String(rounded);
  forms.add(intStr);
  forms.add(rounded.toLocaleString("en-US"));
  forms.add(rounded.toLocaleString("en-US").replace(/,/g, " "));
  if (!Number.isInteger(price)) {
    forms.add(String(price));
    forms.add(price.toLocaleString("en-US", { maximumFractionDigits: 4 }));
  }
  if (rounded >= 1000) {
    const k = trimDecimals(rounded / 1000, 3);
    for (const suffix of ["k", " k", " thousand"]) forms.add(`${k}${suffix}`);
  }
  return [...forms].map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

export function numberAppearsIn(price: number, text: string): boolean {
  const hay = normalizeText(text);
  return numberForms(price).some((src) =>
    new RegExp(`(?<![\\d.,])${src}(?![\\d]|[.,]\\d)(?![a-z])`, "i").test(hay),
  );
}

export function evidenceAppearsIn(evidence: string, transcript: string): boolean {
  const needle = normalizeText(evidence).replace(/^["'…\s]+|["'…\s]+$/g, "");
  return needle.length >= 8 && normalizeText(transcript).includes(needle);
}

function lowerConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

/**
 * Deterministic guard on the extractor's output: every evidence span must occur in the transcript
 * and every numeric level must occur in some surviving span. Unsupported levels are dropped and
 * confidence is lowered one bucket if anything was dropped. Pure; never calls a model.
 */
export function verifyEvidence(
  prior: AnalystPrior,
  transcriptText: string,
): { prior: AnalystPrior; report: EvidenceReport } {
  const keptEvidence = prior.evidence.filter((e) => evidenceAppearsIn(e, transcriptText));
  const evidenceDropped = prior.evidence.filter((e) => !keptEvidence.includes(e));
  if (keptEvidence.length === 0) {
    throw new UnsupportedPriorError(
      prior.videoId,
      `${prior.evidence.length} evidence span(s), none found in transcript`,
    );
  }
  const evidenceText = keptEvidence.join("\n");
  const levelsDropped: EvidenceReport["levelsDropped"] = [];
  const supported = (field: string, level: PriceLevel | null): PriceLevel | null => {
    if (!level) return null;
    if (numberAppearsIn(level.price, evidenceText)) return level;
    levelsDropped.push({ field, price: level.price, label: level.label });
    return null;
  };

  const keyLevels = prior.keyLevels.filter((l) => supported("keyLevels", l) !== null);
  const targets = prior.targets.filter((l) => supported("targets", l) !== null);
  const invalidation = supported("invalidation", prior.invalidation);
  let entryZone = prior.entryZone;
  if (entryZone) {
    const lowOk = numberAppearsIn(entryZone.low, evidenceText);
    const highOk = numberAppearsIn(entryZone.high, evidenceText);
    if (!lowOk || !highOk) {
      levelsDropped.push({
        field: "entryZone",
        price: lowOk ? entryZone.high : entryZone.low,
        label: entryZone.label,
      });
      entryZone = null;
    }
  }

  const dropped = evidenceDropped.length > 0 || levelsDropped.length > 0;
  const verified: AnalystPrior = {
    ...prior,
    asset: "BTC",
    keyLevels,
    targets,
    invalidation,
    entryZone,
    evidence: keptEvidence,
    confidence: dropped ? lowerConfidence(prior.confidence) : prior.confidence,
  };
  return {
    prior: verified,
    report: {
      evidenceChecked: prior.evidence.length,
      evidenceDropped,
      levelsDropped,
      confidenceLowered: dropped,
    },
  };
}
