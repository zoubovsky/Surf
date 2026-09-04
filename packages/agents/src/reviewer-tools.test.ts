import { describe, expect, it } from "vitest";
import * as F from "./testing/fixtures.js";
import { createReviewerTools } from "./tools/reviewer-tools.js";

const tools = () =>
  createReviewerTools({
    ew: { h1: F.ewAnalysis(), h4: F.ew4h() },
    prior: F.prior(),
    market: F.market(),
    limits: F.limits(),
  });

describe("reviewer tools", () => {
  it("finds candidates on both intervals", () => {
    expect(tools().getCandidate("4h:imp-1")?.interval).toBe("4h");
    expect(tools().getCandidate("nope")).toBeNull();
  });

  it("stop check passes a stop beyond invalidation within the band", () => {
    const r = tools().checkStopVsInvalidation(F.plan());
    expect(r.ok).toBe(true);
    expect(r.bufferPct).toBeCloseTo((400 / 76_000) * 100, 5);
  });

  it("stop check fails a stop inside invalidation", () => {
    const r = tools().checkStopVsInvalidation(F.plan({ stopLoss: { price: 76_500, label: "inside" } }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("INSIDE");
  });

  it("recomputes R:R from the worst fill with fees and funding", () => {
    const r = tools().recomputeRewardRisk(F.plan());
    // entry 78100 (far edge for a long), stop 75600 -> risk 2500; gross 4300; fee 39.05; funding 0.00001*78100*24 = 18.744
    expect(r.entryPrice).toBe(78_100);
    expect(r.riskPerUnit).toBe(2_500);
    expect(r.rewardRisk).toBeCloseTo((4_300 - 39.05 - 18.744) / 2_500, 3);
  });

  it("R:R is null for non-entry plans and adverse-side stops", () => {
    expect(tools().recomputeRewardRisk(F.plan({ action: "hold" })).rewardRisk).toBeNull();
    expect(
      tools().recomputeRewardRisk(F.plan({ stopLoss: { price: 79_000, label: "wrong side" } })).rewardRisk,
    ).toBeNull();
  });

  it("exposes prior levels with freshness", () => {
    const p = tools().getPriorLevels();
    expect(p).toMatchObject({
      videoId: "vid1",
      bias: "long",
      invalidation: 76_000,
      targets: [82_400],
      fresh: true,
      ageHours: 6,
    });
  });
});
