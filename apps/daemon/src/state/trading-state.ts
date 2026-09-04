import { eq } from "drizzle-orm";
import type { Logger, RiskLimits, TradingState } from "@surf/core";
import { TradingState as TradingStateSchema } from "@surf/core";
import { kvGet, kvSet, schema, type Db } from "../db/index.js";

const KEY = "trading-state";

export interface StateStoreOptions {
  db: Db;
  log: Logger;
  limits: RiskLimits;
  tradingMode: "shadow" | "live";
  tz: string;
  now?: () => number;
}

/** Local calendar day for a timestamp in the configured time zone (YYYY-MM-DD). */
export function dayKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ts),
  );
}

/**
 * Persistent trading state: pause/halt flags, day-start and high-water equity, entry counters,
 * consecutive stop-outs, LLM spend. All mutations go through here and are journaled.
 */
export class TradingStateStore {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly limits: RiskLimits;
  private readonly tz: string;
  private readonly now: () => number;
  private readonly tradingMode: "shadow" | "live";
  private state: TradingState;
  private dayOf: string;

  constructor(opts: StateStoreOptions) {
    this.db = opts.db;
    this.log = opts.log.child({ component: "state" });
    this.limits = opts.limits;
    this.tz = opts.tz;
    this.now = opts.now ?? (() => Date.now());
    this.tradingMode = opts.tradingMode;
    const stored = kvGet<{ state: TradingState; dayOf: string }>(this.db, KEY);
    this.state = stored
      ? TradingStateSchema.parse({ ...stored.state, tradingMode: opts.tradingMode })
      : TradingStateSchema.parse({
          tradingMode: opts.tradingMode,
          paused: false,
          halted: false,
          haltReason: null,
          haltedAt: null,
          dayStartEquity: 0,
          highWaterEquity: 0,
          entriesToday: 0,
          lastEntryAt: null,
          consecutiveStopOuts: 0,
          llmSpendTodayUsd: 0,
        });
    this.dayOf = stored?.dayOf ?? dayKey(this.now(), this.tz);
  }

  get(): TradingState {
    return { ...this.state, tradingMode: this.tradingMode };
  }

  private save(): void {
    kvSet(this.db, KEY, { state: this.state, dayOf: this.dayOf }, this.now());
  }

  private event(level: "info" | "warn" | "critical", kind: string, payload: unknown): void {
    this.db.insert(schema.events).values({ at: this.now(), level, kind, payload }).run();
  }

  /** Call with a fresh equity reading. Handles day rollover, high-water mark, and halt cooldown re-arm. */
  observeEquity(equity: number): { rolledOver: boolean; reArmed: boolean } {
    const now = this.now();
    const today = dayKey(now, this.tz);
    let rolledOver = false;
    if (today !== this.dayOf) {
      this.dayOf = today;
      this.state.dayStartEquity = equity;
      this.state.entriesToday = 0;
      this.state.llmSpendTodayUsd = 0;
      rolledOver = true;
      this.event("info", "day-rollover", { day: today, equity });
    }
    if (this.state.dayStartEquity === 0) this.state.dayStartEquity = equity;
    if (equity > this.state.highWaterEquity) this.state.highWaterEquity = equity;
    let reArmed = false;
    if (this.state.halted && this.state.haltedAt !== null) {
      const cooldownMs = this.limits.haltCooldownHours * 3_600_000;
      if (now - this.state.haltedAt >= cooldownMs) {
        this.state.halted = false;
        this.state.haltReason = null;
        this.state.haltedAt = null;
        this.state.consecutiveStopOuts = 0;
        reArmed = true;
        this.event("warn", "halt-rearmed", { after: cooldownMs });
        this.log.warn("automatic halt re-armed after cooldown");
      }
    }
    this.save();
    return { rolledOver, reArmed };
  }

  /** Evaluate automatic halt conditions against a fresh equity reading. Returns the reason if newly halted. */
  checkAutoHalt(equity: number): string | null {
    if (this.state.halted) return null;
    const s = this.state;
    const dailyLossPct = s.dayStartEquity > 0 ? ((s.dayStartEquity - equity) / s.dayStartEquity) * 100 : 0;
    const ddPct = s.highWaterEquity > 0 ? ((s.highWaterEquity - equity) / s.highWaterEquity) * 100 : 0;
    let reason: string | null = null;
    if (dailyLossPct >= this.limits.maxDailyLossPct) reason = `daily loss ${dailyLossPct.toFixed(2)}% >= ${this.limits.maxDailyLossPct}%`;
    else if (ddPct >= this.limits.maxDrawdownPct) reason = `drawdown ${ddPct.toFixed(2)}% >= ${this.limits.maxDrawdownPct}%`;
    else if (s.consecutiveStopOuts >= this.limits.maxConsecutiveStopOuts)
      reason = `${s.consecutiveStopOuts} consecutive stop-outs`;
    if (reason) this.halt(reason);
    return reason;
  }

  halt(reason: string): void {
    this.state.halted = true;
    this.state.haltReason = reason;
    this.state.haltedAt = this.now();
    this.event("critical", "halt", { reason });
    this.log.error({ reason }, "trading halted");
    this.save();
  }

  pause(): void {
    this.state.paused = true;
    this.event("warn", "pause", {});
    this.save();
  }

  resume(): void {
    this.state.paused = false;
    // operator resume also clears an automatic halt
    this.state.halted = false;
    this.state.haltReason = null;
    this.state.haltedAt = null;
    this.state.consecutiveStopOuts = 0;
    this.event("info", "resume", {});
    this.save();
  }

  recordEntry(): void {
    this.state.entriesToday += 1;
    this.state.lastEntryAt = this.now();
    this.save();
  }

  recordExit(realizedR: number, reason: string): void {
    if (reason === "stop" || reason === "invalidation" || realizedR <= -0.5) this.state.consecutiveStopOuts += 1;
    else if (realizedR > 0) this.state.consecutiveStopOuts = 0;
    this.save();
  }

  recordLlmSpend(usd: number): void {
    const today = dayKey(this.now(), this.tz);
    this.state.llmSpendTodayUsd += usd;
    const row = this.db.select().from(schema.llmSpend).where(eq(schema.llmSpend.day, today)).get();
    if (row) {
      this.db
        .update(schema.llmSpend)
        .set({ usd: row.usd + usd, calls: row.calls + 1 })
        .where(eq(schema.llmSpend.day, today))
        .run();
    } else {
      this.db.insert(schema.llmSpend).values({ day: today, usd, calls: 1 }).run();
    }
    this.save();
  }

  llmBudgetRemaining(): number {
    return Math.max(0, this.limits.dailyLlmBudgetUsd - this.state.llmSpendTodayUsd);
  }
}
