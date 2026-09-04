import { describe, expect, it } from "vitest";
import {
  checkCorrection,
  checkImpulse,
  classifyCorrection,
  ruleAlternation,
  ruleDiagonalWedge,
  ruleFlatB,
  ruleWave2NotBeyondOrigin,
  ruleWave3NotShortest,
  ruleWave4NoOverlap,
  ruleZigzagB,
  ruleZigzagC,
} from "./rules.js";

// Textbook up impulse: W1 10, W2 61.8%, W3 1.618×W1, W4 38.2% of W3, W5 = W1.
const TEXTBOOK = [100, 110, 103.82, 120, 113.82, 123.82];
// Mirror image down.
const TEXTBOOK_DOWN = TEXTBOOK.map((p) => 200 - p);

describe("hard rule 1: W2 ≤ 100% of W1", () => {
  it("passes a normal retrace and a full (100%) retrace", () => {
    expect(ruleWave2NotBeyondOrigin(TEXTBOOK).passed).toBe(true);
    expect(ruleWave2NotBeyondOrigin([100, 110, 100]).passed).toBe(true);
    expect(ruleWave2NotBeyondOrigin(TEXTBOOK_DOWN).passed).toBe(true);
  });
  it("fails when W2 goes beyond the origin, in both directions", () => {
    const r = ruleWave2NotBeyondOrigin([100, 110, 99]);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("110.0%");
    expect(ruleWave2NotBeyondOrigin([100, 90, 101]).passed).toBe(false);
  });
  it("is not evaluated with fewer than 3 pivots", () => {
    const r = ruleWave2NotBeyondOrigin([100, 110]);
    expect(r).toMatchObject({ passed: true, evaluated: false });
  });
});

describe("hard rule 2: W3 not the shortest", () => {
  it("passes when W3 is longest or middle", () => {
    expect(ruleWave3NotShortest(TEXTBOOK).passed).toBe(true);
    expect(ruleWave3NotShortest([100, 110, 105, 117, 113, 128]).passed).toBe(true); // W1 10, W3 12, W5 15 → W3 middle
  });
  it("fails when W3 is shorter than both W1 and W5", () => {
    expect(ruleWave3NotShortest([100, 110, 105, 113, 111, 121]).passed).toBe(false);
    expect(ruleWave3NotShortest([100, 110, 105, 113, 111, 118]).passed).toBe(true); // W5 = 7 < W3 = 8
    expect(ruleWave3NotShortest(TEXTBOOK_DOWN).passed).toBe(true);
  });
  it("is not evaluated before W5 is known", () => {
    expect(ruleWave3NotShortest(TEXTBOOK.slice(0, 5)).evaluated).toBe(false);
  });
});

describe("hard rule 3: W4 does not overlap W1", () => {
  const overlapping = [100, 110, 104, 112, 108, 113];
  it("passes without overlap and fails with overlap for impulses", () => {
    expect(ruleWave4NoOverlap(TEXTBOOK).passed).toBe(true);
    expect(ruleWave4NoOverlap(TEXTBOOK_DOWN).passed).toBe(true);
    const r = ruleWave4NoOverlap(overlapping);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("entered W1 territory");
    expect(ruleWave4NoOverlap(overlapping.map((p) => 200 - p)).passed).toBe(false);
  });
  it("treats a touch (W4 end == W1 end) as no overlap", () => {
    expect(ruleWave4NoOverlap([100, 110, 104, 120, 110, 125]).passed).toBe(true);
  });
  it("allows overlap only under the diagonal pattern", () => {
    expect(ruleWave4NoOverlap(overlapping, "diagonal").passed).toBe(true);
    expect(ruleWave4NoOverlap(overlapping, "impulse").passed).toBe(false);
  });
  it("is not evaluated with fewer than 5 pivots", () => {
    expect(ruleWave4NoOverlap(TEXTBOOK.slice(0, 4)).evaluated).toBe(false);
  });
});

describe("diagonal wedge", () => {
  const contracting = [100, 110, 104, 112, 108, 113]; // W: 10, 6, 8, 4, 5
  const expanding = [100, 105, 102, 110, 104, 116]; // W: 5, 3, 8, 6, 12
  it("contracting: each wave shorter than the one two before", () => {
    expect(ruleDiagonalWedge(contracting, "contracting").passed).toBe(true);
    expect(ruleDiagonalWedge(contracting, "expanding").passed).toBe(false);
  });
  it("expanding: each wave longer than the one two before", () => {
    expect(ruleDiagonalWedge(expanding, "expanding").passed).toBe(true);
    expect(ruleDiagonalWedge(expanding, "contracting").passed).toBe(false);
  });
  it("evaluates partial structures on the waves known so far", () => {
    expect(ruleDiagonalWedge(contracting.slice(0, 4), "contracting").passed).toBe(true);
    expect(ruleDiagonalWedge(contracting.slice(0, 3), "contracting").evaluated).toBe(false);
  });
});

describe("checkImpulse", () => {
  it("passes a textbook impulse and reports every rule", () => {
    const r = checkImpulse(TEXTBOOK);
    expect(r.passed).toBe(true);
    expect(r.pattern).toBe("impulse");
    expect(r.rules.map((x) => x.rule)).toEqual(["alternation", "W2 ≤ 100% of W1", "W3 not shortest", "W4 does not overlap W1"]);
    expect(r.rules.every((x) => x.evaluated)).toBe(true);
  });
  it("fails an impulse with overlap but passes it as a contracting diagonal", () => {
    const overlapping = [100, 110, 104, 112, 108, 113];
    expect(checkImpulse(overlapping).passed).toBe(false);
    const d = checkImpulse(overlapping, { pattern: "diagonal" });
    expect(d.passed).toBe(true);
    expect(d.pattern).toBe("diagonal");
    expect(d.rules.some((x) => x.rule === "contracting wedge" && x.passed)).toBe(true);
  });
  it("diagonal still requires the wedge shape: overlap with a non-wedge shape fails", () => {
    const notWedge = [100, 110, 104, 125, 108, 118]; // W: 10, 6, 21, 17, 10 → W3 > W1 (not contracting), W5 < W3 (not expanding)
    expect(checkImpulse(notWedge, { pattern: "diagonal" }).passed).toBe(false);
    expect(checkImpulse(notWedge, { pattern: "diagonal", wedge: "expanding" }).passed).toBe(false);
  });
  it("fails on non-alternating pivots", () => {
    expect(ruleAlternation([100, 110, 112]).passed).toBe(false);
    expect(ruleAlternation([100, 100]).passed).toBe(false);
    expect(checkImpulse([100, 110, 112, 105]).passed).toBe(false);
  });
  it("passes prefixes whose unknown waves cannot be evaluated yet", () => {
    const r = checkImpulse(TEXTBOOK.slice(0, 3));
    expect(r.passed).toBe(true);
    expect(r.rules.filter((x) => x.evaluated).map((x) => x.rule)).toEqual(["alternation", "W2 ≤ 100% of W1"]);
  });
});

describe("corrections", () => {
  const zigzagDown = [120, 100, 112, 96]; // A -20, B +12 (60%), C -16 beyond A
  const flatDown = [120, 100, 119, 99]; // B 95% → flat
  const expandedFlat = [120, 100, 124, 97]; // B 120%

  it("classifies by B retracement", () => {
    expect(classifyCorrection(zigzagDown)).toBe("zigzag");
    expect(classifyCorrection(flatDown)).toBe("flat");
    expect(classifyCorrection(expandedFlat)).toBe("flat");
    expect(classifyCorrection([100, 120, 108])).toBe("zigzag");
  });
  it("zigzag: B < 100% of A and C beyond A", () => {
    expect(ruleZigzagB(zigzagDown).passed).toBe(true);
    expect(ruleZigzagC(zigzagDown).passed).toBe(true);
    expect(ruleZigzagB([120, 100, 121, 96]).passed).toBe(false);
    expect(ruleZigzagC([120, 100, 112, 101]).passed).toBe(false); // C fails to exceed A
    expect(ruleZigzagC([120, 100, 112]).evaluated).toBe(false);
    const up = zigzagDown.map((p) => 240 - p);
    expect(checkCorrection(up).passed).toBe(true);
    expect(checkCorrection(up).pattern).toBe("zigzag");
  });
  it("flat: B between 90% and 138.2% of A", () => {
    expect(ruleFlatB(flatDown).passed).toBe(true);
    expect(ruleFlatB(expandedFlat).passed).toBe(true);
    expect(ruleFlatB([120, 100, 112, 96]).passed).toBe(false);
    expect(ruleFlatB([120, 100, 130, 96]).passed).toBe(false); // 150%
    expect(checkCorrection(flatDown).pattern).toBe("flat");
    expect(checkCorrection(flatDown).passed).toBe(true);
    expect(checkCorrection([120, 100, 130, 96]).passed).toBe(false);
  });
  it("a forced kind is honoured", () => {
    expect(checkCorrection(zigzagDown, "flat").passed).toBe(false);
    expect(checkCorrection(flatDown, "zigzag").passed).toBe(true); // B 95% < 100%, C beyond A
  });
});
