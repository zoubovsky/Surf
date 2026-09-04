import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCandles, main, normalizeRow, summarize } from "./bench.js";
import { analyze } from "./engine.js";
import { syntheticImpulse } from "./synthetic.js";

const P5 = 100 + 10 * (1 - 0.618 + 1.618 - 0.618 + 1);

describe("bench", () => {
  const series = syntheticImpulse({ seed: 5, tail: [{ price: P5 - 8, bars: 12 }] });
  const dir = mkdtempSync(join(tmpdir(), "ew-bench-"));

  it("loads core-shaped, loose-object and kline-array files identically", () => {
    const core = join(dir, "core.json");
    const loose = join(dir, "loose.json");
    const kline = join(dir, "kline.json");
    writeFileSync(core, JSON.stringify(series.candles));
    writeFileSync(
      loose,
      JSON.stringify({
        data: [...series.candles].reverse().map((c) => ({ t: c.openTime / 1000, o: String(c.open), h: c.high, l: c.low, c: c.close, v: c.volume })),
      }),
    );
    writeFileSync(kline, JSON.stringify(series.candles.map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime])));
    const a = loadCandles(core);
    const b = loadCandles(loose);
    const c = loadCandles(kline);
    expect(a).toHaveLength(series.candles.length);
    expect(b.map((x) => [x.openTime, x.open, x.high, x.low, x.close])).toEqual(a.map((x) => [x.openTime, x.open, x.high, x.low, x.close]));
    expect(c.map((x) => x.closeTime)).toEqual(a.map((x) => x.closeTime));
    expect(analyze(b).candidates.map((x) => x.id)).toEqual(analyze(series.candles).candidates.map((x) => x.id));
  });

  it("rejects unsupported rows and shapes", () => {
    expect(() => normalizeRow(42, {})).toThrow(/unsupported row/);
    expect(() => normalizeRow({ open: "x", high: 1, low: 1, close: 1, time: 1 }, {})).toThrow(/not a number/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ nothing: true }));
    expect(() => loadCandles(bad)).toThrow(/candle array/);
  });

  it("prints a candidate summary and JSON", () => {
    const path = join(dir, "series.json");
    writeFileSync(path, JSON.stringify(series.candles));
    const text = main([path, "--topk", "2"]);
    expect(text).toContain("candidates: 2");
    expect(text).toContain("#1 impulse complete → short");
    expect(text).toContain("invalidation:");
    const json = JSON.parse(main([path, "--json"])) as { candidates: unknown[] };
    expect(json.candidates.length).toBeGreaterThan(0);
    expect(summarize(analyze(series.candles.slice(0, 3)))).toContain("candidates: 0");
    expect(() => main([])).toThrow(/usage/);
  });
});
