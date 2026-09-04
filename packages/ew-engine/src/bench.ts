/**
 * Offline bench: `tsx packages/ew-engine/src/bench.ts <candles.json> [--interval 1h] [--topk 5] [--json]`
 *
 * Reads a JSON candle file (no network), runs `analyze`, and prints candidate summaries.
 * Accepted shapes: an array of core `Candle` objects; an array of objects with loose keys
 * (openTime|time|t|open_time, closeTime|close_time, open|o, high|h, low|l, close|c, volume|v);
 * an array of kline arrays `[openTime, open, high, low, close, volume, closeTime?]`; or an
 * object wrapping one of those under `candles` or `data`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Candle, INTERVAL_MS } from "@surf/core";
import type { EwAnalysis, EwCandidate, Interval } from "@surf/core";
import { analyze } from "./engine.js";
import { fmt } from "./util.js";

export interface LoadOptions {
  interval?: Interval;
  symbol?: string;
  venue?: string;
}

type Loose = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`bench: not a number: ${String(v)}`);
  return n;
}

function pick(row: Loose, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined) return row[k];
  return undefined;
}

function toMs(t: number): number {
  return t < 1e12 ? t * 1000 : t;
}

/** Normalise one loose row into a core Candle. */
export function normalizeRow(row: unknown, opts: LoadOptions): Candle {
  const interval = opts.interval ?? "1h";
  const ms = INTERVAL_MS[interval];
  let openTime: number;
  let closeTime: number | undefined;
  let o: number;
  let h: number;
  let l: number;
  let c: number;
  let v: number;
  if (Array.isArray(row)) {
    openTime = toMs(num(row[0]));
    o = num(row[1]);
    h = num(row[2]);
    l = num(row[3]);
    c = num(row[4]);
    v = row[5] === undefined ? 0 : num(row[5]);
    closeTime = row[6] === undefined ? undefined : toMs(num(row[6]));
  } else if (row && typeof row === "object") {
    const r = row as Loose;
    openTime = toMs(num(pick(r, ["openTime", "open_time", "time", "t", "timestamp", "ts"])));
    const ct = pick(r, ["closeTime", "close_time", "T"]);
    closeTime = ct === undefined ? undefined : toMs(num(ct));
    o = num(pick(r, ["open", "o"]));
    h = num(pick(r, ["high", "h"]));
    l = num(pick(r, ["low", "l"]));
    c = num(pick(r, ["close", "c"]));
    const vol = pick(r, ["volume", "v", "vol"]);
    v = vol === undefined ? 0 : num(vol);
  } else {
    throw new Error("bench: unsupported row shape");
  }
  return Candle.parse({
    venue: opts.venue ?? "file",
    symbol: opts.symbol ?? "BTC-USD",
    interval,
    openTime: Math.trunc(openTime),
    closeTime: Math.trunc(closeTime ?? openTime + ms - 1),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: Math.max(0, v),
  });
}

/** Load and normalise a candle file, sorted by openTime with duplicates removed. */
export function loadCandles(path: string, opts: LoadOptions = {}): Candle[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  let rows: unknown[];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === "object") {
    const r = raw as Loose;
    const inner = r["candles"] ?? r["data"] ?? r["klines"];
    if (!Array.isArray(inner)) throw new Error("bench: could not find a candle array in the file");
    rows = inner;
  } else throw new Error("bench: unsupported JSON shape");
  const candles = rows.map((row) => normalizeRow(row, opts));
  candles.sort((a, b) => a.openTime - b.openTime);
  return candles.filter((c, i) => i === 0 || c.openTime !== candles[i - 1]?.openTime);
}

function describeCandidate(c: EwCandidate, i: number): string {
  const lines = [
    `#${i + 1} ${c.pattern} ${c.position} → ${c.direction}  score ${c.score.toFixed(3)}  id ${c.id}`,
    `   pivots: ${c.pivots.map((p) => `${p.kind[0]}@${fmt(p.price)}`).join(" → ")}`,
    `   invalidation: ${fmt(c.invalidation.price)} (${c.invalidation.label})`,
    `   entry: ${c.entryZone ? `${fmt(c.entryZone.low)}–${fmt(c.entryZone.high)} (${c.entryZone.label})` : "none"}`,
  ];
  for (const t of c.targets) lines.push(`   target: ${fmt(t.low)}–${fmt(t.high)} (${t.label})`);
  return lines.join("\n");
}

/** Human-readable summary of an analysis. */
export function summarize(a: EwAnalysis): string {
  const head = [
    `${a.symbol} ${a.interval} asOf ${new Date(a.asOf).toISOString()} close ${fmt(a.lastClose)}`,
    `swings: ${a.swings.length}  rsi14: ${a.momentum.rsi14 === null ? "n/a" : a.momentum.rsi14.toFixed(1)}  atr14: ${
      a.momentum.atr14 === null ? "n/a" : fmt(a.momentum.atr14)
    }  divergence: ${a.momentum.rsiDivergence}`,
    `candidates: ${a.candidates.length}`,
  ];
  return [...head, ...a.candidates.map(describeCandidate)].join("\n");
}

function parseArgs(argv: string[]): { path: string; interval: Interval; topK: number; json: boolean } {
  let path = "";
  let interval: Interval = "1h";
  let topK = 5;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--interval") interval = (argv[++i] ?? "1h") as Interval;
    else if (a === "--topk") topK = Number(argv[++i] ?? "5");
    else if (a === "--json") json = true;
    else if (a && !a.startsWith("--")) path = a;
  }
  if (!path) throw new Error("usage: bench <candles.json> [--interval 1h|4h|1d] [--topk N] [--json]");
  return { path, interval, topK, json };
}

export function main(argv: string[] = process.argv.slice(2)): string {
  const { path, interval, topK, json } = parseArgs(argv);
  const candles = loadCandles(path, { interval });
  const analysis = analyze(candles, { topK });
  return json ? JSON.stringify(analysis, null, 2) : summarize(analysis);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.stdout.write(`${main()}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
