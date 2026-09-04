import { describe, expect, it } from "vitest";
import { priceFor, UsageMeter, usageToTotals, ZERO_USAGE, addTotals } from "./usage.js";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("UsageMeter", () => {
  it("prices opus-5 input, cache read, 5m cache write and output", () => {
    const t = usageToTotals("claude-opus-5", {
      input_tokens: 1_000,
      output_tokens: 300,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 500,
    });
    // 1000*5 + 2000*0.5 + 500*6.25 + 300*25 per MTok
    near(t.costUsd, (1_000 * 5 + 2_000 * 0.5 + 500 * 6.25 + 300 * 25) / 1e6);
    expect(t).toMatchObject({
      inputTokens: 1_000,
      cachedReadTokens: 2_000,
      cacheWriteTokens: 500,
      outputTokens: 300,
    });
  });

  it("prices 1h-TTL cache writes at 2x when the breakdown is present", () => {
    const t = usageToTotals("claude-opus-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 400 },
    });
    near(t.costUsd, (600 * 10 + 400 * 6.25) / 1e6);
  });

  it("prices sonnet-5", () => {
    const t = usageToTotals("claude-sonnet-5", {
      input_tokens: 10_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 5_000,
      cache_creation_input_tokens: 0,
    });
    near(t.costUsd, (10_000 * 2 + 5_000 * 0.2 + 1_000 * 10) / 1e6);
  });

  it("prices haiku-4-5", () => {
    const t = usageToTotals("claude-haiku-4-5", {
      input_tokens: 20_000,
      output_tokens: 200,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 4_000,
    });
    near(t.costUsd, (20_000 * 1 + 1_000 * 0.1 + 4_000 * 1.25 + 200 * 5) / 1e6);
  });

  it("prices fable-5-1 with its 0.025x cache reads", () => {
    const t = usageToTotals("claude-fable-5-1", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 0,
    });
    near(t.costUsd, (1_000 * 10 + 10_000 * 0.25 + 100 * 50) / 1e6);
  });

  it("resolves dated ids by longest prefix and falls back to the most expensive row", () => {
    expect(priceFor("claude-opus-5-20260601")).toBe(priceFor("claude-opus-5"));
    expect(priceFor("claude-haiku-4-5-20251001").input).toBe(1);
    expect(priceFor("some-new-model")).toBe(priceFor("claude-fable-5-1"));
  });

  it("accumulates across responses and models", () => {
    const m = new UsageMeter();
    m.add("claude-opus-5", { input_tokens: 1_000, output_tokens: 0 });
    m.add("claude-sonnet-5", { input_tokens: 1_000, output_tokens: 0 });
    near(m.totals.costUsd, 0.005 + 0.002);
    expect(m.totals.inputTokens).toBe(2_000);
    expect(Object.keys(m.byModel()).sort()).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    near(addTotals(ZERO_USAGE, m.totals).costUsd, m.totals.costUsd);
  });
});
