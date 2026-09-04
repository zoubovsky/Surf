import { describe, expect, it } from "vitest";
import { RiskLimits, createLogger } from "@surf/core";
import { openDb } from "../db/index.js";
import { TradingStateStore, dayKey } from "./trading-state.js";

const T0 = Date.UTC(2026, 8, 4, 10, 0, 0);

function make(now: { t: number }, limits = RiskLimits.parse({})) {
  const { db } = openDb({ path: ":memory:" });
  const mk = () =>
    new TradingStateStore({
      db,
      log: createLogger("silent"),
      limits,
      tradingMode: "live",
      tz: "UTC",
      now: () => now.t,
    });
  return { db, mk };
}

describe("TradingStateStore", () => {
  it("computes day keys in the configured zone", () => {
    expect(dayKey(Date.UTC(2026, 8, 4, 23, 30), "UTC")).toBe("2026-09-04");
    expect(dayKey(Date.UTC(2026, 8, 4, 23, 30), "Europe/London")).toBe("2026-09-05");
  });

  it("initialises day-start and high-water on first equity and persists across instances", () => {
    const now = { t: T0 };
    const { mk } = make(now);
    const a = mk();
    a.observeEquity(10_000);
    a.recordEntry();
    const b = mk();
    expect(b.get().dayStartEquity).toBe(10_000);
    expect(b.get().highWaterEquity).toBe(10_000);
    expect(b.get().entriesToday).toBe(1);
  });

  it("rolls the day over and resets counters", () => {
    const now = { t: T0 };
    const { mk } = make(now);
    const s = mk();
    s.observeEquity(10_000);
    s.recordEntry();
    s.recordLlmSpend(2);
    now.t = Date.UTC(2026, 8, 5, 0, 5);
    const r = s.observeEquity(10_500);
    expect(r.rolledOver).toBe(true);
    expect(s.get().entriesToday).toBe(0);
    expect(s.get().llmSpendTodayUsd).toBe(0);
    expect(s.get().dayStartEquity).toBe(10_500);
    expect(s.get().highWaterEquity).toBe(10_500);
  });

  it("halts on daily loss and re-arms after the cooldown", () => {
    const now = { t: T0 };
    const { mk } = make(now);
    const s = mk();
    s.observeEquity(10_000);
    expect(s.checkAutoHalt(9_750)).toBeNull();
    expect(s.checkAutoHalt(9_690)).toMatch(/daily loss/);
    expect(s.get().halted).toBe(true);
    now.t += 23 * 3_600_000;
    expect(s.observeEquity(9_690).reArmed).toBe(false);
    now.t += 2 * 3_600_000;
    expect(s.observeEquity(9_690).reArmed).toBe(true);
    expect(s.get().halted).toBe(false);
  });

  it("halts on drawdown from high-water and on consecutive stop-outs", () => {
    const now = { t: T0 };
    const { mk } = make(now);
    const s = mk();
    s.observeEquity(10_000);
    now.t = Date.UTC(2026, 8, 5, 1, 0);
    s.observeEquity(9_000); // new day starts at 9,000; high-water stays 10,000
    expect(s.checkAutoHalt(8_995)).toMatch(/drawdown/);
    s.resume();
    s.recordExit(-1, "stop");
    s.recordExit(-1, "stop");
    expect(s.checkAutoHalt(10_000)).toBeNull();
    s.recordExit(-1, "invalidation");
    expect(s.checkAutoHalt(10_000)).toMatch(/consecutive/);
    s.resume();
    s.recordExit(2, "take-profit");
    expect(s.get().consecutiveStopOuts).toBe(0);
  });

  it("tracks LLM spend and remaining budget", () => {
    const now = { t: T0 };
    const { mk } = make(now, RiskLimits.parse({ dailyLlmBudgetUsd: 5 }));
    const s = mk();
    s.recordLlmSpend(1.5);
    s.recordLlmSpend(2);
    expect(s.llmBudgetRemaining()).toBeCloseTo(1.5);
    expect(s.get().llmSpendTodayUsd).toBeCloseTo(3.5);
  });
});
