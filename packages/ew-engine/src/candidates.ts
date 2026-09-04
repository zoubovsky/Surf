import type {
  Direction,
  EwCandidate,
  Interval,
  PriceLevel,
  PriceZone,
  Swing,
  WavePattern,
  WavePosition,
} from "@surf/core";
import {
  extensionZone,
  retraceLevel,
  retraceZone,
  scoreCorrectionGuidelines,
  scoreImpulseGuidelines,
  waveLengths,
} from "./fib.js";
import { divergenceBetween } from "./indicators.js";
import { bRetrace, checkCorrection, checkImpulse, classifyCorrection } from "./rules.js";
import type { ImpulsePattern, RuleResult } from "./rules.js";
import { at, clamp01, fmt, last, round, sgn, truncate, zone } from "./util.js";
import type { ZigZagResult } from "./zigzag.js";

export interface CandidateContext {
  interval: Interval;
  lastClose: number;
  /** RSI series aligned with the candles. */
  rsi: readonly (number | null)[];
  /** Interval length in ms (near-duplicate tolerance is 2 bars). */
  intervalMs: number;
}

export interface CandidateOptions {
  /** Maximum candidates returned. Default 5. */
  topK?: number;
  /** How many of the most recent confirmed pivots per degree are considered. Default 9. */
  maxPivots?: number;
}

/** Weights of the final score. Exported for documentation and tests. */
export const SCORE_WEIGHTS = { guideline: 0.5, prior: 0.25, momentum: 0.15, degree: 0.1 } as const;

/** A candidate before scoring/merging across degrees. */
export interface RawCandidate {
  base: Omit<EwCandidate, "score">;
  /** Guideline (Fib/alternation/extension) score 0..1. */
  guideline: number;
  /** Structural prior: how much of the structure is confirmed / how tradable the position is. */
  prior: number;
  /** Momentum confluence 0..1 (0.5 = neutral). */
  momentum: number;
  /** Position-specific multiplier (e.g. reversal calls after a complete impulse are discounted). */
  multiplier: number;
  /** ZigZag degrees (ATR multiples) that produced this structure. */
  degrees: number[];
}

const IMPULSE_POSITION: Record<number, WavePosition> = {
  2: "in-wave-2",
  3: "in-wave-3",
  4: "in-wave-4",
  5: "in-wave-5",
  6: "complete",
};

function rsiAt(ctx: CandidateContext, index: number): number | null {
  const v = ctx.rsi[index];
  return v === undefined ? null : v;
}

/** True when RSI at `index` is extreme in direction `dir` (≥70 for up, ≤30 for down). */
function rsiExtreme(ctx: CandidateContext, index: number, dir: 1 | -1): boolean {
  const v = rsiAt(ctx, index);
  if (v === null) return false;
  return dir > 0 ? v >= 70 : v <= 30;
}

function ruleNotes(rules: readonly RuleResult[]): string[] {
  return rules.filter((r) => r.evaluated).map((r) => `rule ${r.rule}: ${r.detail}`);
}

function makeId(interval: Interval, pattern: WavePattern, window: readonly Swing[]): string {
  return `${interval}-${pattern}-${at(window, 0).time}-${last(window).time}`;
}

function sane(inv: PriceLevel, targets: readonly PriceZone[], entry: PriceZone | null): boolean {
  if (!(inv.price > 0)) return false;
  if (targets.some((t) => !(t.low > 0) || !(t.high > 0))) return false;
  if (entry && (!(entry.low > 0) || !(entry.high > 0))) return false;
  return true;
}

/**
 * Build an impulse (or diagonal) candidate from 2..6 confirmed alternating pivots plus the
 * provisional extreme of the current leg. Returns null when a hard rule fails.
 */
export function buildImpulseCandidate(
  window: readonly Swing[],
  provisional: Swing | null,
  ctx: CandidateContext,
  degree: number,
): RawCandidate | null {
  const m = window.length;
  if (m < 2 || m > 6) return null;
  const dir: 1 | -1 = at(window, 0).kind === "low" ? 1 : -1;
  const prices = window.map((p) => p.price);
  const withProvisional = m < 6 && provisional !== null;
  const evalPrices = withProvisional ? [...prices, provisional.price] : prices;
  const durations: number[] = [];
  for (let i = 1; i < window.length; i++) durations.push(at(window, i).index - at(window, i - 1).index);
  if (withProvisional) durations.push(provisional.index - last(window).index);

  let report = checkImpulse(evalPrices, { pattern: "impulse" });
  let pattern: ImpulsePattern = "impulse";
  if (!report.passed) {
    const onlyOverlap = report.rules.every((r) => r.passed || r.rule === "W4 does not overlap W1");
    if (!onlyOverlap) return null;
    const contracting = checkImpulse(evalPrices, { pattern: "diagonal", wedge: "contracting" });
    const expanding = checkImpulse(evalPrices, { pattern: "diagonal", wedge: "expanding" });
    if (contracting.passed) report = contracting;
    else if (expanding.passed) report = expanding;
    else return null;
    pattern = "diagonal";
  }

  const position = IMPULSE_POSITION[m];
  if (!position) return null;
  const w = waveLengths(prices);
  const w1 = at(w, 0);
  if (w1 <= 0) return null;
  const p0 = at(prices, 0);
  const p1 = at(prices, 1);
  const inProgressEnd = provisional?.price ?? ctx.lastClose;
  const notes: string[] = [];
  let direction: Direction = dir > 0 ? "long" : "short";
  let invalidation: PriceLevel;
  let targets: PriceZone[] = [];
  let entryZone: PriceZone | null = null;
  let prior: number;
  let multiplier = 1;
  let momentum = 0.5;

  const w5Targets = (from: number, w3: number): PriceZone => {
    const a = w1;
    const b = 0.618 * (w1 + w3);
    return zone(
      from + dir * Math.min(a, b),
      from + dir * Math.max(a, b),
      "W5 target: W1 / 0.618×(W1+W3) from W4 end",
    );
  };

  switch (position) {
    case "in-wave-2": {
      invalidation = { price: p0, label: "W1 origin (W2 may not retrace more than 100% of W1)" };
      entryZone = retraceZone(p0, p1, 0.618, 0.5, "W2 end zone: 50–61.8% retrace of W1");
      targets = [
        extensionZone(inProgressEnd, w1, 1.0, 1.618, dir, "W3 target: 1.0–1.618×W1 from W2 end (est.)"),
      ];
      prior = 0.45;
      if (rsiExtreme(ctx, at(window, 1).index, dir)) {
        momentum += 0.15;
        notes.push("momentum: W1 ended at an RSI extreme (impulsive first wave)");
      }
      break;
    }
    case "in-wave-3": {
      const p2 = at(prices, 2);
      invalidation = { price: p2, label: "W2 extreme (a break means W2 is not finished; count fails)" };
      targets = [
        extensionZone(p2, w1, 1.0, 1.618, dir, "W3 target: 1.0–1.618×W1 from W2 end"),
        extensionZone(p2, w1, 1.618, 2.618, dir, "W3 extended: 1.618–2.618×W1 from W2 end"),
      ];
      prior = 0.5;
      multiplier = 0.95;
      if (provisional && rsiExtreme(ctx, provisional.index, dir)) {
        momentum += 0.15;
        notes.push("momentum: RSI extreme during W3 (so far)");
      }
      break;
    }
    case "in-wave-4": {
      const p2 = at(prices, 2);
      const p3 = at(prices, 3);
      const w3 = at(w, 2);
      invalidation =
        pattern === "diagonal"
          ? { price: p2, label: "W2 extreme (diagonal W4 may overlap W1 but not exceed W2)" }
          : { price: p1, label: "W1 extreme (W4 may not enter W1 territory)" };
      entryZone = retraceZone(p2, p3, 0.382, 0.236, "W4 end zone: 23.6–38.2% retrace of W3");
      targets = [w5Targets(inProgressEnd, w3)];
      prior = 0.65;
      if (rsiExtreme(ctx, p3IndexOf(window), dir)) {
        momentum += 0.2;
        notes.push("momentum: W3 ended at an RSI extreme (strongest wave)");
      }
      break;
    }
    case "in-wave-5": {
      const p4 = at(prices, 4);
      const w3 = at(w, 2);
      invalidation = { price: p4, label: "W4 extreme" };
      targets = [w5Targets(p4, w3)];
      prior = 0.7;
      multiplier = 0.9;
      if (rsiExtreme(ctx, at(window, 3).index, dir)) momentum += 0.1;
      if (provisional && divergenceBetween(at(window, 3), provisional, ctx.rsi) !== "none") {
        momentum -= 0.25;
        notes.push("momentum: W5 diverging from W3 on RSI — termination risk");
      }
      break;
    }
    default: {
      // complete
      const p4 = at(prices, 4);
      const p5 = at(prices, 5);
      direction = dir > 0 ? "short" : "long";
      invalidation = { price: p5, label: "W5 extreme (a new extreme means the impulse is not complete)" };
      targets = [
        retraceZone(p0, p5, 0.5, 0.382, "correction target: 38.2–50% retrace of the impulse"),
        zone(p4, retraceLevel(p0, p5, 0.618), "deeper correction: W4 extreme to 61.8% retrace"),
      ];
      prior = 0.8;
      multiplier = 0.85;
      if (rsiExtreme(ctx, at(window, 3).index, dir)) momentum += 0.1;
      const div = divergenceBetween(at(window, 3), at(window, 5), ctx.rsi);
      if (div !== "none") {
        momentum += 0.25;
        notes.push(`momentum: ${div} RSI divergence W5 vs W3 supports completion`);
      } else notes.push("momentum: no RSI divergence between W3 and W5");
      break;
    }
  }

  if (!sane(invalidation, targets, entryZone)) return null;
  if (position === "complete")
    multiplier *= targetProgressMultiplier(direction, targets, ctx.lastClose, notes);

  const guideline = scoreImpulseGuidelines(evalPrices, durations);
  notes.push(...ruleNotes(report.rules), ...guideline.notes.map((n) => `guideline ${n}`));
  if (pattern === "diagonal") notes.push("diagonal: W4/W1 overlap permitted under the wedge rule");
  if (withProvisional)
    notes.push(`current leg extreme ${fmt(provisional.price)} used as provisional next pivot`);

  return {
    base: {
      id: makeId(ctx.interval, pattern, window),
      interval: ctx.interval,
      pattern,
      direction,
      position,
      pivots: [...window],
      invalidation: { price: round(invalidation.price), label: truncate(invalidation.label, 120) },
      targets,
      entryZone,
      hardRulesPassed: true,
      notes,
    },
    guideline: guideline.score,
    prior,
    momentum: clamp01(momentum),
    multiplier,
    degrees: [degree],
  };
}

/**
 * Discount structures whose first target has already been reached by the last close: the count may
 * be right, but the move it implies is largely spent.
 */
function targetProgressMultiplier(
  direction: Direction,
  targets: readonly PriceZone[],
  lastClose: number,
  notes: string[],
): number {
  const first = targets[0];
  if (!first) return 1;
  const reached = direction === "long" ? lastClose >= first.low : lastClose <= first.high;
  if (!reached) return 1;
  notes.push("first target zone already reached by the last close");
  return 0.7;
}

function p3IndexOf(window: readonly Swing[]): number {
  return at(window, 3).index;
}

function correctionTargets(x: number, cEnd: number, tradeDir: 1 | -1): PriceZone[] {
  const span = Math.abs(x - cEnd);
  return [
    zone(cEnd + tradeDir * 0.618 * span, x, "61.8–100% retrace of the correction (back to X)"),
    zone(x, cEnd + tradeDir * 1.618 * span, "1.0–1.618× correction extension beyond X"),
  ];
}

/**
 * Build a 3-wave correction candidate from pivots [X, A, B] (+ provisional C in progress) or
 * [X, A, B, C] (complete). `preceding` are the confirmed pivots before X, used to detect whether
 * the correction follows a rule-valid impulse.
 */
export function buildCorrectionCandidate(
  window: readonly Swing[],
  provisional: Swing | null,
  preceding: readonly Swing[],
  ctx: CandidateContext,
  degree: number,
): RawCandidate | null {
  const m = window.length;
  if (m < 3 || m > 4) return null;
  const X = at(window, 0);
  const A = at(window, 1);
  const B = at(window, 2);
  const dirA = sgn(A.price - X.price);
  const tradeDir: 1 | -1 = dirA > 0 ? -1 : 1;
  const prices = window.map((p) => p.price);
  const rB = bRetrace(prices);
  if (!Number.isFinite(rB) || rB > 1.382) return null;
  const kind = classifyCorrection(prices);
  const report = checkCorrection(prices, kind);
  if (!report.passed) return null;

  const wA = Math.abs(A.price - X.price);
  const direction: Direction = tradeDir > 0 ? "long" : "short";
  const notes: string[] = [];
  let position: WavePosition;
  let invalidation: PriceLevel;
  let entryZone: PriceZone | null = null;
  let targets: PriceZone[];
  let prior: number;
  let momentum = 0.5;
  let cEnd: number;

  if (m === 3) {
    if (!provisional) return null;
    position = "in-wave-c";
    const c1 = B.price + dirA * 1.0 * wA;
    const c1618 = B.price + dirA * 1.618 * wA;
    const invPrice = B.price + dirA * (1.618 + 0.1) * wA;
    if ((provisional.price - invPrice) * dirA >= 0) return null;
    invalidation = { price: invPrice, label: "beyond the 1.618×A projection of C (+10% of A buffer)" };
    entryZone = zone(c1, c1618, "C end zone: 1.0–1.618×A projected from B");
    cEnd = (provisional.price - c1) * dirA > 0 ? provisional.price : c1;
    targets = correctionTargets(X.price, cEnd, tradeDir);
    prior = 0.5;
    const div = divergenceBetween(A, provisional, ctx.rsi);
    if (div !== "none") {
      momentum += 0.25;
      notes.push(`momentum: ${div} RSI divergence C vs A supports termination`);
    }
  } else {
    const C = at(window, 3);
    position = "complete";
    invalidation = { price: C.price, label: "C extreme (correction end)" };
    cEnd = C.price;
    targets = correctionTargets(X.price, cEnd, tradeDir);
    prior = 0.6;
    const div = divergenceBetween(A, C, ctx.rsi);
    if (div !== "none") {
      momentum += 0.25;
      notes.push(`momentum: ${div} RSI divergence C vs A`);
    }
  }

  if (preceding.length >= 5) {
    const imp = [...preceding.slice(-5), X];
    const expectedStart = tradeDir > 0 ? "low" : "high";
    if (at(imp, 0).kind === expectedStart && checkImpulse(imp.map((p) => p.price)).passed) {
      prior += 0.15;
      notes.push("context: corrects a rule-valid 5-wave impulse ending at X");
    }
  }

  if (!sane(invalidation, targets, entryZone)) return null;
  const multiplier = m === 4 ? targetProgressMultiplier(direction, targets, ctx.lastClose, notes) : 1;

  const guideline = scoreCorrectionGuidelines(prices, kind);
  notes.push(...ruleNotes(report.rules), ...guideline.notes.map((n) => `guideline ${n}`));
  if (m === 3 && provisional) notes.push(`C in progress, extreme so far ${fmt(provisional.price)}`);

  return {
    base: {
      id: makeId(ctx.interval, kind, window),
      interval: ctx.interval,
      pattern: kind,
      direction,
      position,
      pivots: [...window],
      invalidation: { price: round(invalidation.price), label: truncate(invalidation.label, 120) },
      targets,
      entryZone,
      hardRulesPassed: true,
      notes,
    },
    guideline: guideline.score,
    prior,
    momentum: clamp01(momentum),
    multiplier,
    degrees: [degree],
  };
}

/** Degree-agreement component: 0 for one degree, 0.5 for two, 1 for three or more. */
export function degreeAgreement(count: number): number {
  return count >= 3 ? 1 : count === 2 ? 0.5 : 0;
}

/** Final deterministic score of a raw candidate. */
export function scoreCandidate(raw: RawCandidate): number {
  const s =
    SCORE_WEIGHTS.guideline * raw.guideline +
    SCORE_WEIGHTS.prior * clamp01(raw.prior) +
    SCORE_WEIGHTS.momentum * raw.momentum +
    SCORE_WEIGHTS.degree * degreeAgreement(raw.degrees.length);
  return round(clamp01(s * raw.multiplier), 4);
}

function sameStructure(a: RawCandidate, b: RawCandidate, intervalMs: number): boolean {
  if (a.base.id === b.base.id) return true;
  if (a.base.pattern !== b.base.pattern || a.base.position !== b.base.position) return false;
  if (a.base.direction !== b.base.direction || a.base.pivots.length !== b.base.pivots.length) return false;
  const tol = 2 * intervalMs;
  for (let i = 0; i < a.base.pivots.length; i++) {
    if (Math.abs(at(a.base.pivots, i).time - at(b.base.pivots, i).time) > tol) return false;
  }
  return true;
}

/** Merge candidates that describe the same structure at different degrees. */
export function dedupeCandidates(raws: readonly RawCandidate[], intervalMs: number): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const r of raws) {
    const idx = out.findIndex((o) => sameStructure(o, r, intervalMs));
    if (idx < 0) {
      out.push({ ...r, degrees: [...r.degrees] });
      continue;
    }
    const existing = at(out, idx);
    const degrees = [...new Set([...existing.degrees, ...r.degrees])].sort((x, y) => x - y);
    const keep = scoreCandidate(existing) >= scoreCandidate(r) ? existing : r;
    out[idx] = { ...keep, degrees };
  }
  return out;
}

function finalize(raw: RawCandidate): EwCandidate {
  const notes = [...raw.base.notes];
  if (raw.degrees.length > 1) notes.push(`seen at ZigZag degrees k=${raw.degrees.join(", ")}`);
  else notes.push(`seen at ZigZag degree k=${raw.degrees.join(", ")}`);
  return {
    ...raw.base,
    notes: notes.slice(0, 16).map((n) => truncate(n, 200)),
    score: scoreCandidate(raw),
  };
}

/**
 * Enumerate rule-valid candidates from the most recent pivots of every degree, merge duplicates,
 * score, sort (score desc, id asc) and return the top-k.
 */
export function enumerateCandidates(
  degrees: readonly ZigZagResult[],
  ctx: CandidateContext,
  opts: CandidateOptions = {},
): EwCandidate[] {
  const topK = opts.topK ?? 5;
  const maxPivots = opts.maxPivots ?? 9;
  const raws: RawCandidate[] = [];
  for (const d of degrees) {
    const recent = d.confirmed.slice(-maxPivots);
    for (let m = 2; m <= Math.min(6, recent.length); m++) {
      const r = buildImpulseCandidate(recent.slice(-m), d.provisional, ctx, d.k);
      if (r) raws.push(r);
    }
    for (let m = 3; m <= Math.min(4, recent.length); m++) {
      const r = buildCorrectionCandidate(
        recent.slice(-m),
        d.provisional,
        recent.slice(0, recent.length - m),
        ctx,
        d.k,
      );
      if (r) raws.push(r);
    }
  }
  const merged = dedupeCandidates(raws, ctx.intervalMs).map(finalize);
  merged.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return merged.slice(0, topK);
}
