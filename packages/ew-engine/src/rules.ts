import { waveLengths } from "./fib.js";
import { at, fmt, pctStr, sgn } from "./util.js";

export interface RuleResult {
  rule: string;
  passed: boolean;
  /** False when the structure is too short to evaluate the rule; `passed` is then true. */
  evaluated: boolean;
  detail: string;
}

export type ImpulsePattern = "impulse" | "diagonal";
export type WedgeShape = "contracting" | "expanding";

export interface ImpulseRuleOptions {
  pattern?: ImpulsePattern;
  /** Diagonal shape requirement. Default contracting. */
  wedge?: WedgeShape;
}

export interface RuleReport<P extends string> {
  pattern: P;
  passed: boolean;
  rules: RuleResult[];
}

const notEvaluable = (rule: string, need: number, have: number): RuleResult => ({
  rule,
  passed: true,
  evaluated: false,
  detail: `needs ${need} pivots, have ${have}`,
});

/** Direction of the first leg: +1 when p1 > p0. */
export function structureDirection(prices: readonly number[]): 1 | -1 {
  if (prices.length < 2) return 1;
  return sgn(at(prices, 1) - at(prices, 0));
}

/**
 * Pivots must strictly alternate: every leg must move in the opposite direction of the previous
 * leg and have non-zero length.
 */
export function ruleAlternation(prices: readonly number[]): RuleResult {
  const rule = "alternation";
  if (prices.length < 2) return notEvaluable(rule, 2, prices.length);
  const dir = structureDirection(prices);
  for (let i = 1; i < prices.length; i++) {
    const move = at(prices, i) - at(prices, i - 1);
    const expected = i % 2 === 1 ? dir : -dir;
    if (move === 0 || sgn(move) !== expected) {
      return { rule, passed: false, evaluated: true, detail: `leg ${i} does not alternate (move ${fmt(move)})` };
    }
  }
  return { rule, passed: true, evaluated: true, detail: `${prices.length} pivots alternate` };
}

/** Hard rule 1: wave 2 never retraces more than 100% of wave 1. */
export function ruleWave2NotBeyondOrigin(prices: readonly number[]): RuleResult {
  const rule = "W2 ≤ 100% of W1";
  if (prices.length < 3) return notEvaluable(rule, 3, prices.length);
  const w = waveLengths(prices);
  const w1 = at(w, 0);
  const w2 = at(w, 1);
  const r = w1 === 0 ? Infinity : w2 / w1;
  return {
    rule,
    passed: r <= 1,
    evaluated: true,
    detail: `W2 retraced ${pctStr(r)} of W1 (origin ${fmt(at(prices, 0))})`,
  };
}

/** Hard rule 2: wave 3 is never the shortest of waves 1, 3, 5. */
export function ruleWave3NotShortest(prices: readonly number[]): RuleResult {
  const rule = "W3 not shortest";
  if (prices.length < 6) return notEvaluable(rule, 6, prices.length);
  const w = waveLengths(prices);
  const w1 = at(w, 0);
  const w3 = at(w, 2);
  const w5 = at(w, 4);
  const shortest = w3 < w1 && w3 < w5;
  return {
    rule,
    passed: !shortest,
    evaluated: true,
    detail: `W1 ${fmt(w1)}, W3 ${fmt(w3)}, W5 ${fmt(w5)}`,
  };
}

/**
 * Hard rule 3: wave 4 never enters wave 1's price territory. Overlap is permitted only when
 * `pattern === "diagonal"` (the wedge-shape rule then applies instead).
 */
export function ruleWave4NoOverlap(prices: readonly number[], pattern: ImpulsePattern = "impulse"): RuleResult {
  const rule = "W4 does not overlap W1";
  if (prices.length < 5) return notEvaluable(rule, 5, prices.length);
  const dir = structureDirection(prices);
  const p1 = at(prices, 1);
  const p4 = at(prices, 4);
  const overlap = (p4 - p1) * dir < 0;
  if (pattern === "diagonal") {
    return {
      rule,
      passed: true,
      evaluated: true,
      detail: overlap ? `overlap of ${fmt(Math.abs(p4 - p1))} allowed in diagonal` : "no overlap (diagonal)",
    };
  }
  return {
    rule,
    passed: !overlap,
    evaluated: true,
    detail: overlap
      ? `W4 end ${fmt(p4)} entered W1 territory (W1 end ${fmt(p1)})`
      : `W4 end ${fmt(p4)} stays outside W1 end ${fmt(p1)}`,
  };
}

/**
 * Diagonal shape: contracting requires W3 < W1, W5 < W3 and W4 < W2; expanding the reverse.
 * Evaluated on whatever waves are known so far (at least W1 and W3).
 */
export function ruleDiagonalWedge(prices: readonly number[], wedge: WedgeShape = "contracting"): RuleResult {
  const rule = `${wedge} wedge`;
  if (prices.length < 4) return notEvaluable(rule, 4, prices.length);
  const w = waveLengths(prices);
  const lt = (a: number, b: number): boolean => (wedge === "contracting" ? a < b : a > b);
  const checks: [string, boolean][] = [];
  checks.push(["W3 vs W1", lt(at(w, 2), at(w, 0))]);
  if (w.length >= 4) checks.push(["W4 vs W2", lt(at(w, 3), at(w, 1))]);
  if (w.length >= 5) checks.push(["W5 vs W3", lt(at(w, 4), at(w, 2))]);
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  return {
    rule,
    passed: failed.length === 0,
    evaluated: true,
    detail: failed.length === 0 ? `${checks.length} wedge checks pass` : `fails ${failed.join(", ")}`,
  };
}

/**
 * Run all hard rules for a 5-wave structure (or its known prefix, 2..6 pivots).
 * Rules that cannot be evaluated yet are reported with `evaluated: false` and count as passed.
 */
export function checkImpulse(prices: readonly number[], opts: ImpulseRuleOptions = {}): RuleReport<ImpulsePattern> {
  const pattern = opts.pattern ?? "impulse";
  const rules: RuleResult[] = [
    ruleAlternation(prices),
    ruleWave2NotBeyondOrigin(prices),
    ruleWave3NotShortest(prices),
    ruleWave4NoOverlap(prices, pattern),
  ];
  if (pattern === "diagonal") rules.push(ruleDiagonalWedge(prices, opts.wedge ?? "contracting"));
  return { pattern, passed: rules.every((r) => r.passed), rules };
}

export type CorrectionKind = "zigzag" | "flat";

/** Retracement of A by B, for prices [X, A, B, ...]. */
export function bRetrace(prices: readonly number[]): number {
  if (prices.length < 3) return NaN;
  const w = waveLengths(prices);
  const wA = at(w, 0);
  return wA === 0 ? Infinity : at(w, 1) / wA;
}

/** Classify a correction from B's retracement of A: < 90% zigzag, otherwise flat. */
export function classifyCorrection(prices: readonly number[]): CorrectionKind {
  const r = bRetrace(prices);
  return Number.isFinite(r) && r >= 0.9 ? "flat" : "zigzag";
}

/** Zigzag: B retraces less than 100% of A. */
export function ruleZigzagB(prices: readonly number[]): RuleResult {
  const rule = "zigzag B < 100% of A";
  if (prices.length < 3) return notEvaluable(rule, 3, prices.length);
  const r = bRetrace(prices);
  return { rule, passed: r < 1, evaluated: true, detail: `B retraced ${pctStr(r)} of A` };
}

/** Zigzag: C extends beyond the end of A. */
export function ruleZigzagC(prices: readonly number[]): RuleResult {
  const rule = "zigzag C beyond A";
  if (prices.length < 4) return notEvaluable(rule, 4, prices.length);
  const dir = structureDirection(prices);
  const a = at(prices, 1);
  const c = at(prices, 3);
  const beyond = (c - a) * dir > 0;
  return { rule, passed: beyond, evaluated: true, detail: `C ${fmt(c)} vs A ${fmt(a)}` };
}

/** Flat: B retraces at least 90% of A (and no more than 138.2%, the expanded-flat limit). */
export function ruleFlatB(prices: readonly number[]): RuleResult {
  const rule = "flat B ≥ 90% of A";
  if (prices.length < 3) return notEvaluable(rule, 3, prices.length);
  const r = bRetrace(prices);
  return {
    rule,
    passed: r >= 0.9 && r <= 1.382,
    evaluated: true,
    detail: `B retraced ${pctStr(r)} of A (flat range 90–138.2%)`,
  };
}

/**
 * Run the hard rules for a 3-wave correction X→A→B(→C). The kind is classified from B's
 * retracement unless given.
 */
export function checkCorrection(prices: readonly number[], kind?: CorrectionKind): RuleReport<CorrectionKind> {
  const k = kind ?? classifyCorrection(prices);
  const rules: RuleResult[] = [ruleAlternation(prices)];
  if (k === "zigzag") rules.push(ruleZigzagB(prices), ruleZigzagC(prices));
  else rules.push(ruleFlatB(prices));
  return { pattern: k, passed: rules.every((r) => r.passed), rules };
}
