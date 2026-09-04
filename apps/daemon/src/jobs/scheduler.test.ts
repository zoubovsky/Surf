import { describe, expect, it } from "vitest";
import { hourlyCycleId } from "./scheduler.js";

describe("hourlyCycleId", () => {
  it("names the candle that just closed", () => {
    expect(hourlyCycleId(Date.UTC(2026, 8, 4, 13, 1, 5))).toBe("hourly-2026-09-04T12Z");
    expect(hourlyCycleId(Date.UTC(2026, 8, 4, 0, 1, 0))).toBe("hourly-2026-09-03T23Z");
  });
});
