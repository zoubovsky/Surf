/**
 * Synthetic candle generators for tests (exported so other packages can build known-answer
 * inputs). Everything is deterministic given a seed.
 */
import { INTERVAL_MS } from "@surf/core";
import type { Candle, Interval } from "@surf/core";
import { at, last } from "./util.js";

export interface PathPoint {
  /** Price reached at the end of this leg. */
  price: number;
  /** Number of bars the leg takes (≥ 1). */
  bars: number;
}

export interface SyntheticOptions {
  symbol?: string;
  venue?: string;
  interval?: Interval;
  /** openTime of the first candle (Unix ms). Default 2024-01-01T00:00Z. */
  startTime?: number;
  seed?: number;
  /** Noise amplitude as a fraction of the mean absolute per-bar move. Default 0.25. 0 = clean lines. */
  noise?: number;
  volume?: number;
}

export interface SyntheticSeries {
  candles: Candle[];
  /** Candle index of every pivot (origin first, then each leg end). */
  pivotIndices: number[];
  /** Realised extreme price of each pivot (includes the pivot wick). */
  pivotPrices: number[];
  /** Nominal leg-end prices (origin first), without wicks. */
  targets: number[];
}

/** Deterministic uniform [0,1) generator (Park–Miller minimal standard). */
export function lcg(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const DEFAULT_START = Date.UTC(2024, 0, 1);

/**
 * Trace a piecewise-linear price path with bounded noise. Each leg's end bar carries a wick that
 * makes it the strict extreme of the leg, so the realised pivots are known exactly.
 */
export function candlesFromPath(start: number, points: readonly PathPoint[], opts: SyntheticOptions = {}): SyntheticSeries {
  const symbol = opts.symbol ?? "BTC-USD";
  const venue = opts.venue ?? "synthetic";
  const interval = opts.interval ?? "1h";
  const ms = INTERVAL_MS[interval];
  const startTime = opts.startTime ?? DEFAULT_START;
  const rng = lcg(opts.seed ?? 1);
  const noise = opts.noise ?? 0.25;
  const volume = opts.volume ?? 100;

  const legs = points.filter((p) => p.bars >= 1);
  let totalBars = 0;
  let totalMove = 0;
  let from = start;
  for (const leg of legs) {
    totalBars += leg.bars;
    totalMove += Math.abs(leg.price - from);
    from = leg.price;
  }
  const meanStep = totalBars > 0 ? totalMove / totalBars : 0;
  const amp = noise * meanStep;

  const candles: Candle[] = [];
  const pivotIndices: number[] = [];
  const pivotPrices: number[] = [];
  const targets: number[] = [start];

  let prevClose = start;
  let bar = 0;
  from = start;
  const firstUp = legs.length > 0 ? at(legs, 0).price >= start : true;
  for (const leg of legs) {
    const to = leg.price;
    const up = to >= from;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const margin = Math.min(amp * 0.01, (hi - lo) * 0.01);
    for (let j = 1; j <= leg.bars; j++) {
      const isEnd = j === leg.bars;
      let close: number;
      if (isEnd) close = to;
      else {
        const base = from + ((to - from) * j) / leg.bars;
        const n = (rng() * 2 - 1) * amp;
        close = Math.min(hi - margin, Math.max(lo + margin, base + n));
      }
      const open = prevClose;
      let high = Math.max(open, close) + rng() * 0.5 * amp;
      let low = Math.min(open, close) - rng() * 0.5 * amp;
      if (isEnd) {
        if (up) high = to + amp;
        else low = to - amp;
      }
      if (bar === 0) {
        // Make the origin a clean extreme too.
        if (firstUp) low = Math.min(low, start - amp);
        else high = Math.max(high, start + amp);
      }
      const openTime = startTime + bar * ms;
      candles.push({
        venue,
        symbol,
        interval,
        openTime,
        closeTime: openTime + ms - 1,
        open,
        high,
        low,
        close,
        volume,
      });
      prevClose = close;
      if (isEnd) {
        pivotIndices.push(bar);
        pivotPrices.push(up ? high : low);
        targets.push(to);
      }
      bar++;
    }
    from = to;
  }
  if (candles.length > 0) {
    const c0 = at(candles, 0);
    pivotIndices.unshift(0);
    pivotPrices.unshift(firstUp ? c0.low : c0.high);
  }
  return { candles, pivotIndices, pivotPrices, targets };
}

export interface ImpulseRatios {
  /** W2 retrace of W1. Default 0.618. */
  w2?: number;
  /** W3 as a multiple of W1. Default 1.618. */
  w3?: number;
  /** W4 retrace of W3. Default 0.382. */
  w4?: number;
  /** W5 as a multiple of W1. Default 1.0. */
  w5?: number;
}

/** Nominal leg ends of a 5-wave impulse from `start` with wave-1 length `w1`. */
export function impulseLegs(
  start: number,
  w1: number,
  ratios: ImpulseRatios = {},
  bars: number | readonly number[] = 20,
  dir: 1 | -1 = 1,
): PathPoint[] {
  const r2 = ratios.w2 ?? 0.618;
  const r3 = ratios.w3 ?? 1.618;
  const r4 = ratios.w4 ?? 0.382;
  const r5 = ratios.w5 ?? 1.0;
  const p1 = start + dir * w1;
  const p2 = p1 - dir * r2 * w1;
  const p3 = p2 + dir * r3 * w1;
  const p4 = p3 - dir * r4 * (r3 * w1);
  const p5 = p4 + dir * r5 * w1;
  const b = (i: number): number => (typeof bars === "number" ? bars : at(bars, i));
  return [
    { price: p1, bars: b(0) },
    { price: p2, bars: b(1) },
    { price: p3, bars: b(2) },
    { price: p4, bars: b(3) },
    { price: p5, bars: b(4) },
  ];
}

export interface CorrectionRatios {
  /** B retrace of A. Default 0.618. */
  b?: number;
  /** C as a multiple of A. Default 1.0. */
  c?: number;
}

/** Nominal leg ends of an A-B-C correction from `start`; `dir` is the direction of wave A. */
export function correctionLegs(
  start: number,
  a: number,
  ratios: CorrectionRatios = {},
  bars: number | readonly number[] = 15,
  dir: 1 | -1 = -1,
): PathPoint[] {
  const rb = ratios.b ?? 0.618;
  const rc = ratios.c ?? 1.0;
  const pA = start + dir * a;
  const pB = pA - dir * rb * a;
  const pC = pB + dir * rc * a;
  const b = (i: number): number => (typeof bars === "number" ? bars : at(bars, i));
  return [
    { price: pA, bars: b(0) },
    { price: pB, bars: b(1) },
    { price: pC, bars: b(2) },
  ];
}

export interface SyntheticImpulseOptions extends SyntheticOptions {
  start?: number;
  w1?: number;
  ratios?: ImpulseRatios;
  bars?: number | readonly number[];
  dir?: 1 | -1;
  /** How many of the five legs to include (1..5). Default 5. */
  legs?: number;
  /** Fraction of the last included leg to trace (0 < f ≤ 1). Default 1. */
  partial?: number;
  /** Extra legs appended after the impulse (e.g. the start of a correction). */
  tail?: readonly PathPoint[];
}

/**
 * A textbook impulse, optionally truncated mid-wave and optionally followed by extra legs.
 * Example: `{ legs: 2, partial: 0.9 }` ends 90% of the way through wave 2.
 */
export function syntheticImpulse(opts: SyntheticImpulseOptions = {}): SyntheticSeries {
  const start = opts.start ?? 100;
  const w1 = opts.w1 ?? 10;
  const dir = opts.dir ?? 1;
  const all = impulseLegs(start, w1, opts.ratios, opts.bars ?? 20, dir);
  const n = Math.max(1, Math.min(5, opts.legs ?? 5));
  const legs = all.slice(0, n);
  const partial = opts.partial ?? 1;
  if (partial < 1 && n >= 1) {
    const lastLeg = at(legs, n - 1);
    const prev = n >= 2 ? at(legs, n - 2).price : start;
    legs[n - 1] = { price: prev + (lastLeg.price - prev) * partial, bars: Math.max(1, Math.round(lastLeg.bars * partial)) };
  }
  return candlesFromPath(start, [...legs, ...(opts.tail ?? [])], opts);
}

export interface RandomWalkOptions extends SyntheticOptions {
  start?: number;
  /** Per-bar log-return standard deviation. Default 0.01. */
  vol?: number;
}

/** Geometric random walk with wicks; prices stay positive. */
export function randomWalk(n: number, opts: RandomWalkOptions = {}): Candle[] {
  const rng = lcg(opts.seed ?? 7);
  const gauss = (): number => {
    const u = Math.max(rng(), 1e-12);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const interval = opts.interval ?? "1h";
  const ms = INTERVAL_MS[interval];
  const startTime = opts.startTime ?? DEFAULT_START;
  const vol = opts.vol ?? 0.01;
  const out: Candle[] = [];
  let prev = opts.start ?? 100;
  for (let i = 0; i < n; i++) {
    const close = prev * Math.exp(vol * gauss());
    const wick = Math.abs(gauss()) * vol * prev * 0.5;
    const high = Math.max(prev, close) + wick * rng();
    const low = Math.max(1e-9, Math.min(prev, close) - wick * rng());
    const openTime = startTime + i * ms;
    out.push({
      venue: opts.venue ?? "synthetic",
      symbol: opts.symbol ?? "BTC-USD",
      interval,
      openTime,
      closeTime: openTime + ms - 1,
      open: prev,
      high,
      low,
      close,
      volume: opts.volume ?? 100,
    });
    prev = close;
  }
  return out;
}

/** Append a candle strictly inside the previous candle's range (never a new extreme). */
export function insideBar(candles: readonly Candle[]): Candle {
  const p = last(candles);
  const mid = (p.high + p.low) / 2;
  const span = (p.high - p.low) * 0.2;
  const ms = INTERVAL_MS[p.interval];
  return {
    ...p,
    openTime: p.openTime + ms,
    closeTime: p.closeTime + ms,
    open: p.close,
    high: Math.max(p.close, mid + span),
    low: Math.min(p.close, mid - span),
    close: mid,
  };
}
