import { describe, expect, it } from "vitest";
import { AnalystPrior } from "@surf/core";
import { UnsupportedPriorError } from "./errors.js";
import { prior, TRANSCRIPT } from "./testing/fixtures.js";
import { numberAppearsIn, numberForms, verifyEvidence } from "./verify-evidence.js";

describe("numberAppearsIn", () => {
  it("accepts k, comma and plain forms", () => {
    expect(numberAppearsIn(79_000, "we bounce at 79k")).toBe(true);
    expect(numberAppearsIn(79_000, "we bounce at 79,000 dollars")).toBe(true);
    expect(numberAppearsIn(79_000, "we bounce at 79000")).toBe(true);
    expect(numberAppearsIn(79_000, "we bounce at $79,000")).toBe(true);
    expect(numberAppearsIn(79_500, "79.5k is the level")).toBe(true);
    expect(numberAppearsIn(79_500, "79.5 thousand")).toBe(true);
    expect(numberAppearsIn(120_000, "one twenty at 120k")).toBe(true);
  });
  it("rejects partial digit matches", () => {
    expect(numberAppearsIn(79_000, "at 179000 we")).toBe(false);
    expect(numberAppearsIn(79_000, "at 79000.5")).toBe(false);
    expect(numberAppearsIn(79_000, "79kg of gold")).toBe(false);
    expect(numberAppearsIn(79_000, "around 78k or 80k")).toBe(false);
  });
  it("generates escaped forms", () => {
    expect(numberForms(79_500)).toEqual(expect.arrayContaining(["79500", "79,500", "79\\.5k"]));
  });
});

describe("verifyEvidence", () => {
  it("keeps a fully supported prior unchanged", () => {
    const { prior: out, report } = verifyEvidence(prior(), TRANSCRIPT);
    expect(out).toEqual(prior());
    expect(report.confidenceLowered).toBe(false);
    expect(report.levelsDropped).toEqual([]);
    expect(AnalystPrior.parse(out)).toBeTruthy();
  });

  it("drops levels not present in any evidence span and lowers confidence", () => {
    const p = prior({
      keyLevels: [
        { price: 76_000, label: "ok" },
        { price: 69_420, label: "invented" },
      ],
      targets: [
        { price: 82_400, label: "ok" },
        { price: 95_000, label: "invented" },
      ],
      invalidation: { price: 74_000, label: "invented" },
      entryZone: { low: 77_000, high: 78_100, label: "half invented" },
    });
    const { prior: out, report } = verifyEvidence(p, TRANSCRIPT);
    expect(out.keyLevels).toEqual([{ price: 76_000, label: "ok" }]);
    expect(out.targets).toEqual([{ price: 82_400, label: "ok" }]);
    expect(out.invalidation).toBeNull();
    expect(out.entryZone).toBeNull();
    expect(out.confidence).toBe("medium");
    expect(report.levelsDropped.map((l) => l.field).sort()).toEqual([
      "entryZone",
      "invalidation",
      "keyLevels",
      "targets",
    ]);
  });

  it("drops evidence spans that are not verbatim in the transcript (case/whitespace-insensitive)", () => {
    const p = prior({
      evidence: [
        "  AS LONG AS WE   hold above 76,000 the count is valid ",
        "the analyst clearly said 76k is the line in the sand",
      ],
    });
    const { prior: out, report } = verifyEvidence(p, TRANSCRIPT);
    expect(out.evidence).toHaveLength(1);
    expect(report.evidenceDropped).toEqual(["the analyst clearly said 76k is the line in the sand"]);
    expect(out.confidence).toBe("medium");
    // 82,400 was only supported by the dropped span -> target dropped too
    expect(out.targets).toEqual([]);
  });

  it("throws when nothing verifies", () => {
    expect(() =>
      verifyEvidence(prior({ evidence: ["completely fabricated sentence about bitcoin"] }), TRANSCRIPT),
    ).toThrow(UnsupportedPriorError);
  });

  it("forces asset to BTC", () => {
    const { prior: out } = verifyEvidence(prior(), TRANSCRIPT);
    expect(out.asset).toBe("BTC");
  });
});
