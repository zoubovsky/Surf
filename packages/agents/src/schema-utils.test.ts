import { describe, expect, it } from "vitest";
import { MarketContext, TradePlan } from "@surf/core";
import { z } from "zod";
import { conform, finalize, lenient, lenientFormat } from "./schema-utils.js";
import * as F from "./testing/fixtures.js";

describe("schema-utils", () => {
  it("lenient strips string/array length checks but keeps shape", () => {
    const strict = z.object({ a: z.string().max(3), b: z.array(z.string().max(2)).max(1), c: z.number().positive().nullable() });
    const loose = lenient(strict);
    expect(loose.safeParse({ a: "toolong", b: ["xx", "yyy"], c: null }).success).toBe(true);
    expect(strict.safeParse({ a: "toolong", b: ["xx", "yyy"], c: null }).success).toBe(false);
    expect(loose.safeParse({ a: 1, b: [], c: null }).success).toBe(false);
  });

  it("conform clips strings and arrays to the strict maxima", () => {
    const strict = z.object({ a: z.string().max(5), b: z.array(z.string().max(2)).max(1), n: z.object({ s: z.string().max(3) }).nullable() });
    expect(conform(strict, { a: "abcdefgh", b: ["xyz", "q"], n: { s: "abcd" } })).toEqual({ a: "abcd…", b: ["x…"], n: { s: "ab…" } });
    expect(conform(strict, { a: "ok", b: [], n: null })).toEqual({ a: "ok", b: [], n: null });
  });

  it("finalize yields the exact core type for an over-long brief", () => {
    const ctx = finalize(MarketContext, { ...F.context(), brief: "x".repeat(2_000), headlines: Array(12).fill("h") });
    expect(ctx.brief.length).toBe(1_500);
    expect(ctx.headlines).toHaveLength(8);
    expect(MarketContext.parse(ctx)).toEqual(ctx);
  });

  it("the API-facing format has no maxLength and round-trips the core schemas", () => {
    const fmt = lenientFormat(TradePlan);
    expect(JSON.stringify(fmt.schema)).not.toContain("maxLength");
    const parsed = fmt.parse(JSON.stringify(F.plan())) as TradePlan;
    expect(TradePlan.parse(parsed)).toEqual(F.plan());
  });
});
