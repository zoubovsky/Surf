import type { PriceZone } from "@surf/core";
import { at, clamp01, pctStr, zone } from "./util.js";

export const FIB = {
  r236: 0.236,
  r382: 0.382,
  r500: 0.5,
  r618: 0.618,
  r786: 0.786,
  e1000: 1,
  e1272: 1.272,
  e1618: 1.618,
  e2618: 2.618,
} as const;

/** Absolute length of a leg. */
export function legLength(from: number, to: number): number {
  return Math.abs(to - from);
}

/** How far `current` has retraced the leg `start → end`, as a ratio of the leg (0 = none, 1 = full). */
export function retraceRatio(start: number, end: number, current: number): number {
  const len = legLength(start, end);
  if (len === 0) return 0;
  return Math.abs(current - end) / len;
}

/** Price at which the leg `start → end` is retraced by `ratio`. */
export function retraceLevel(start: number, end: number, ratio: number): number {
  return end - (end - start) * ratio;
}

/** Project `ratio × legLen` from `from` in direction `dir`. */
export function extensionLevel(from: number, legLen: number, ratio: number, dir: 1 | -1): number {
  return from + dir * legLen * ratio;
}

/** Retracement zone between two ratios of the leg `start → end`. */
export function retraceZone(start: number, end: number, r1: number, r2: number, label: string): PriceZone {
  return zone(retraceLevel(start, end, r1), retraceLevel(start, end, r2), label);
}

/** Extension zone between two ratios of `legLen` projected from `from`. */
export function extensionZone(
  from: number,
  legLen: number,
  r1: number,
  r2: number,
  dir: 1 | -1,
  label: string,
): PriceZone {
  return zone(extensionLevel(from, legLen, r1, dir), extensionLevel(from, legLen, r2, dir), label);
}

/**
 * Piecewise-linear band score: 1 inside [idealLo, idealHi]; falls to 0.5 at the edges of
 * [acceptLo, acceptHi]; falls to 0 one acceptable-band-width beyond that. Monotone away from
 * the ideal band on both sides.
 */
export function bandScore(
  x: number,
  idealLo: number,
  idealHi: number,
  acceptLo: number,
  acceptHi: number,
): number {
  if (!Number.isFinite(x)) return 0;
  if (x >= idealLo && x <= idealHi) return 1;
  const width = Math.max(acceptHi - acceptLo, 1e-9);
  if (x < idealLo) {
    if (x >= acceptLo) return 0.5 + 0.5 * ((x - acceptLo) / Math.max(idealLo - acceptLo, 1e-9));
    return clamp01(0.5 - 0.5 * ((acceptLo - x) / width));
  }
  if (x <= acceptHi) return 0.5 + 0.5 * ((acceptHi - x) / Math.max(acceptHi - idealHi, 1e-9));
  return clamp01(0.5 - 0.5 * ((x - acceptHi) / width));
}

export interface GuidelineResult {
  name: string;
  /** 0..1 */
  score: number;
  weight: number;
  detail: string;
}

export interface GuidelineScore {
  /** Weighted mean of evaluated guidelines, 0..1. 0.5 when nothing could be evaluated. */
  score: number;
  results: GuidelineResult[];
  notes: string[];
}

/** Wave lengths |p_i - p_{i-1}| for i = 1..n-1. */
export function waveLengths(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(legLength(at(prices, i - 1), at(prices, i)));
  return out;
}

function finish(results: GuidelineResult[]): GuidelineScore {
  let sw = 0;
  let s = 0;
  for (const r of results) {
    sw += r.weight;
    s += r.weight * r.score;
  }
  const score = sw === 0 ? 0.5 : clamp01(s / sw);
  const notes = results.map((r) => `${r.name}: ${r.detail} (${r.score.toFixed(2)})`);
  if (results.length === 0) notes.push("no guideline evaluable yet");
  return { score, results, notes };
}

/**
 * Score an impulse (or the known prefix of one) against the Elliott guidelines.
 * `prices` are pivots p0..pn (2 ≤ n+1 ≤ 6); `durations` (bars per wave, same order as waves)
 * optionally sharpen the alternation guideline.
 */
export function scoreImpulseGuidelines(
  prices: readonly number[],
  durations?: readonly number[],
): GuidelineScore {
  const w = waveLengths(prices);
  const results: GuidelineResult[] = [];
  const w1 = w[0];
  const w2 = w[1];
  const w3 = w[2];
  const w4 = w[3];
  const w5 = w[4];
  if (w1 === undefined || w1 === 0) return finish(results);

  let r2: number | undefined;
  if (w2 !== undefined) {
    r2 = w2 / w1;
    results.push({
      name: "W2 retrace",
      score: bandScore(r2, 0.5, 0.618, 0.382, 0.786),
      weight: 1,
      detail: `${pctStr(r2)} of W1 (ideal 50–61.8%, acceptable 38.2–78.6%)`,
    });
  }
  if (w3 !== undefined) {
    const x3 = w3 / w1;
    results.push({
      name: "W3 extension",
      score: bandScore(x3, 1.382, 1.618, 1.0, 2.618),
      weight: 1,
      detail: `${x3.toFixed(3)}× W1 (ideal 1.382–1.618, ≥1.0 expected)`,
    });
  }
  let r4: number | undefined;
  if (w4 !== undefined && w3 !== undefined && w3 > 0) {
    r4 = w4 / w3;
    results.push({
      name: "W4 retrace",
      score: bandScore(r4, 0.236, 0.382, 0.146, 0.5),
      weight: 0.8,
      detail: `${pctStr(r4)} of W3 (ideal 23.6–38.2%)`,
    });
  }
  if (w5 !== undefined && w3 !== undefined) {
    const a = w5 / w1;
    const b = w5 / (0.618 * (w1 + w3));
    const sA = bandScore(a, 0.9, 1.1, 0.618, 1.618);
    const sB = bandScore(b, 0.9, 1.1, 0.7, 1.3);
    const sC = bandScore(a, 0.56, 0.68, 0.45, 0.8);
    const best = Math.max(sA, sB, sC);
    const which = best === sA ? "≈ W1" : best === sB ? "≈ 0.618×(W1+W3)" : "≈ 0.618×W1";
    results.push({
      name: "W5 length",
      score: best,
      weight: 0.8,
      detail: `${a.toFixed(3)}× W1, ${b.toFixed(3)}× 0.618(W1+W3); closest to ${which}`,
    });
  }
  if (r2 !== undefined && r4 !== undefined) {
    const depthDiff = Math.abs(r2 - r4);
    let score = clamp01(depthDiff / 0.25);
    let detail = `W2 ${pctStr(r2)} vs W4 ${pctStr(r4)} depth`;
    if (durations && durations.length >= 4) {
      const d2 = at(durations, 1);
      const d4 = at(durations, 3);
      if (d2 > 0 && d4 > 0) {
        const ratio = Math.max(d2, d4) / Math.min(d2, d4);
        const durScore = clamp01((ratio - 1) / 1.0);
        score = Math.max(score, 0.7 * durScore);
        detail += `, duration ${d2} vs ${d4} bars`;
      }
    }
    results.push({ name: "Alternation", score, weight: 0.6, detail });
  }
  if (w3 !== undefined && w5 !== undefined) {
    const sorted = [w1, w3, w5].sort((a, b) => b - a);
    const ratio = at(sorted, 1) > 0 ? at(sorted, 0) / at(sorted, 1) : 0;
    results.push({
      name: "Extension",
      score: ratio >= 1.618 ? 1 : clamp01((ratio - 1) / 0.618),
      weight: 0.6,
      detail: `longest wave is ${ratio.toFixed(3)}× the next (≥1.618 = one wave extended)`,
    });
  }
  return finish(results);
}

/**
 * Score a 3-wave correction X→A→B(→C) against the guidelines for its kind.
 */
export function scoreCorrectionGuidelines(
  prices: readonly number[],
  kind: "zigzag" | "flat",
): GuidelineScore {
  const w = waveLengths(prices);
  const results: GuidelineResult[] = [];
  const wA = w[0];
  const wB = w[1];
  const wC = w[2];
  if (wA === undefined || wA === 0) return finish(results);
  if (wB !== undefined) {
    const rB = wB / wA;
    results.push(
      kind === "zigzag"
        ? {
            name: "B retrace",
            score: bandScore(rB, 0.5, 0.618, 0.382, 0.786),
            weight: 1,
            detail: `${pctStr(rB)} of A (zigzag ideal 50–61.8%)`,
          }
        : {
            name: "B retrace",
            score: bandScore(rB, 0.9, 1.1, 0.85, 1.382),
            weight: 1,
            detail: `${pctStr(rB)} of A (flat: regular ≈100%, expanded ≤138.2%)`,
          },
    );
  }
  if (wC !== undefined) {
    const rC = wC / wA;
    results.push({
      name: "C length",
      score: bandScore(rC, 1.0, 1.618, 0.618, 2.0),
      weight: 1,
      detail: `${rC.toFixed(3)}× A (cluster 1.0–1.618)`,
    });
  }
  return finish(results);
}
