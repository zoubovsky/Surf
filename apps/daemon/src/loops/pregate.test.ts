import { describe, expect, it } from "vitest";
import { HEARTBEAT_ANALYSIS_HOURS, nearZone, pregate, type PregateInput } from "./pregate.js";

const H = 3_600_000;
const NOW = 1_788_540_000_000;

/** A baseline where every trigger is false. */
function quiet(over: Partial<PregateInput> = {}): PregateInput {
  return {
    kind: "hourly",
    hasOpenPosition: false,
    openDirection: null,
    hasRestingOrder: false,
    topCandidate: { id: "1h-impulse-1-2", position: "in-wave-3" },
    lastTopCandidate: { id: "1h-impulse-1-2", position: "in-wave-3" },
    price: 80_000,
    entryZones: [{ low: 77_500, high: 78_100, label: "w2" }],
    newSignal: false,
    fundingRateHourly: 0.00001,
    maxAdverseFundingHourly: 0.0005,
    lastLlmCycleAt: NOW - 2 * H,
    now: NOW,
    ...over,
  };
}

describe("pregate", () => {
  it("is a no-op when nothing changed", () => {
    const r = pregate(quiet());
    expect(r.run).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("runs for a video-triggered cycle", () => {
    expect(pregate(quiet({ kind: "video" })).reasons[0]).toMatch(/video/);
  });

  it("runs while a position is open or an order rests", () => {
    expect(pregate(quiet({ hasOpenPosition: true, openDirection: "long" })).reasons).toContain(
      "position open",
    );
    expect(pregate(quiet({ hasRestingOrder: true })).reasons).toContain("resting order exists");
  });

  it("runs when the top candidate id or position changed", () => {
    expect(
      pregate(quiet({ topCandidate: { id: "1h-impulse-9-9", position: "in-wave-3" } })).reasons[0],
    ).toMatch(/changed to 1h-impulse-9-9/);
    expect(
      pregate(quiet({ topCandidate: { id: "1h-impulse-1-2", position: "in-wave-4" } })).reasons[0],
    ).toMatch(/moved to in-wave-4/);
    expect(pregate(quiet({ lastTopCandidate: null })).run).toBe(true);
    expect(pregate(quiet({ topCandidate: null, lastTopCandidate: null })).run).toBe(false);
  });

  it("runs when price is inside or within 0.5% of a top-3 entry zone", () => {
    expect(pregate(quiet({ price: 77_800 })).reasons[0]).toMatch(/near entry zone/);
    expect(pregate(quiet({ price: 78_400 })).run).toBe(true); // 0.38% above the zone
    expect(pregate(quiet({ price: 78_600 })).run).toBe(false); // 0.64% above
    expect(nearZone(77_120, { low: 77_500, high: 78_100, label: "" })).toBe(true);
    expect(nearZone(77_100, { low: 77_500, high: 78_100, label: "" })).toBe(false);
  });

  it("runs on a new signal", () => {
    expect(pregate(quiet({ newSignal: true })).reasons).toContain("new analyst prior since last cycle");
  });

  it("runs on adverse funding beyond the limit, relative to the open position when there is one", () => {
    expect(pregate(quiet({ fundingRateHourly: 0.0006 })).run).toBe(true);
    expect(pregate(quiet({ fundingRateHourly: -0.0006 })).run).toBe(true);
    // negative funding favours longs: not adverse for an open long
    expect(
      pregate(quiet({ fundingRateHourly: -0.0006, hasOpenPosition: true, openDirection: "long" })).reasons,
    ).toEqual(["position open"]);
    expect(
      pregate(quiet({ fundingRateHourly: 0.0006, hasOpenPosition: true, openDirection: "long" })).reasons,
    ).toHaveLength(2);
    expect(pregate(quiet({ fundingRateHourly: 0.0004 })).run).toBe(false);
  });

  it("runs a heartbeat analysis after 6h without an LLM cycle, or when none ever ran", () => {
    expect(pregate(quiet({ lastLlmCycleAt: NOW - HEARTBEAT_ANALYSIS_HOURS * H })).reasons[0]).toMatch(
      /heartbeat/,
    );
    expect(pregate(quiet({ lastLlmCycleAt: null })).run).toBe(true);
    expect(pregate(quiet({ lastLlmCycleAt: NOW - 5 * H })).run).toBe(false);
  });

  it("lists every reason that fired", () => {
    const r = pregate(quiet({ kind: "video", hasRestingOrder: true, newSignal: true }));
    expect(r.reasons).toHaveLength(3);
  });
});
