import type { Logger } from "@surf/core";
import { escapeHtml, formatHalt } from "@surf/telegram";
import type { AppContext } from "./context.js";
import { kvGet, kvSet } from "./db/index.js";
import { KV, insertEvent, livePositions } from "./db/queries.js";
import { RECONCILIATION_HALT } from "./loops/monitor.js";
import { persistStats } from "./loops/market-refresh.js";

export interface StartupReport {
  ping: boolean;
  rulesOverridden: string[];
  reconciled: boolean;
  mismatch: string | null;
  equity: number | null;
  backfill: { strike: number; coinbase: number; errors: number } | null;
}

/**
 * Boot checks: venue reachability, exchange rules vs configured limits, position reconciliation
 * against the journal (halt on mismatch), market-data backfill, and the startup notice.
 */
export async function runStartupChecks(ctx: AppContext, log: Logger): Promise<StartupReport> {
  const now = ctx.now();
  const report: StartupReport = {
    ping: false,
    rulesOverridden: [],
    reconciled: false,
    mismatch: null,
    equity: null,
    backfill: null,
  };

  try {
    await ctx.rest.ping();
    report.ping = true;
    ctx.health.markFeed("strike-rest", "ok", null, now);
  } catch (err) {
    ctx.health.markFeed("strike-rest", "down", err instanceof Error ? err.message : String(err), now);
    log.warn({ err: String(err) }, "strike ping failed");
  }

  try {
    const info = await ctx.rest.exchangeInfo();
    const rules = info.symbols.find((s) => s.symbol === ctx.symbol)?.rules;
    if (rules) {
      const overrides: [keyof typeof ctx.limits, number | null][] = [
        ["priceTick", rules.tickSize],
        ["sizeStep", rules.stepSize],
        ["minNotionalUsd", rules.minNotional],
      ];
      for (const [key, value] of overrides) {
        if (value === null || value <= 0) continue;
        const current = ctx.limits[key] as number;
        if (Math.abs(current - value) > 1e-12) {
          log.warn(
            { key, configured: current, exchange: value },
            "exchange rule differs from configured limit; using exchange value",
          );
          (ctx.limits as unknown as Record<string, number>)[key] = value;
          report.rulesOverridden.push(`${key} ${current} -> ${value}`);
        }
      }
    } else {
      log.warn({ symbol: ctx.symbol }, "symbol not present in exchangeInfo");
    }
  } catch (err) {
    log.warn({ err: String(err) }, "exchangeInfo failed; keeping configured limits");
  }

  // Market data: backfill resumes from the repository, so it is cheap on restart and loads history into memory.
  try {
    const b = await ctx.md.backfill();
    report.backfill = { strike: b.strike.fetched, coinbase: b.coinbase.fetched, errors: b.errors.length };
    if (b.errors.length === 0 || b.strike.fetched > 0 || b.coinbase.fetched > 0)
      kvSet(
        ctx.db,
        KV.marketBackfilled,
        { at: now, strike: b.strike.fetched, coinbase: b.coinbase.fetched },
        now,
      );
    persistStats(ctx);
    ctx.health.markFeed(
      "market-data",
      b.errors.length ? "degraded" : "ok",
      b.errors.map((e) => e.source).join(", ") || null,
      now,
    );
  } catch (err) {
    ctx.health.markFeed("market-data", "down", err instanceof Error ? err.message : String(err), now);
    log.error({ err: String(err) }, "market backfill failed at startup");
  }

  // Account + reconciliation (live: real account; shadow: simulator).
  try {
    const account = await ctx.executor.account(ctx.symbol, now);
    report.equity = account.equity;
    ctx.state.observeEquity(account.equity);
    const view = await ctx.executor.view(ctx.symbol, now - 7 * 86_400_000);
    const tracked = livePositions(ctx.db);
    const unknown = view.positions.filter(
      (x) =>
        !tracked.some((p) => p.symbol === x.symbol && p.direction === x.direction && p.status === "open"),
    );
    const orphanOpen = tracked.filter(
      (p) =>
        p.status === "open" &&
        !view.positions.some((x) => x.symbol === p.symbol && x.direction === p.direction),
    );
    if (unknown.length > 0) {
      report.mismatch = `exchange holds ${unknown.map((u) => `${u.direction} ${u.size}@${u.entryPrice}`).join(", ")} not in journal`;
    } else if (orphanOpen.length > 0 && ctx.executor.mode === "live") {
      // The monitor will close these with the exit fills; only warn here.
      log.warn(
        { ids: orphanOpen.map((p) => p.id) },
        "journal has open positions the venue no longer holds; monitor will reconcile",
      );
    }
    if (report.mismatch) {
      if (!(ctx.state.get().halted && ctx.state.get().haltReason === RECONCILIATION_HALT))
        ctx.state.halt(RECONCILIATION_HALT);
      void ctx.notifier.notify(
        "critical",
        formatHalt({
          reason: RECONCILIATION_HALT,
          at: now,
          detail: `${report.mismatch}. No trading until /resume.`,
        }),
      );
    }
    report.reconciled = true;
  } catch (err) {
    log.warn({ err: String(err) }, "account reconciliation skipped");
  }

  const s = ctx.state.get();
  const lines = [
    `🟢 <b>Surf daemon started</b> · v${escapeHtml(ctx.version)} · mode <b>${s.tradingMode.toUpperCase()}</b>`,
    `Equity ${report.equity !== null ? `$${report.equity.toFixed(2)}` : "n/a"} · open positions ${livePositions(ctx.db).filter((p) => p.status === "open").length} · resting ${livePositions(ctx.db).filter((p) => p.status === "resting").length}`,
    `Strike ${report.ping ? "reachable" : "UNREACHABLE"}${ctx.rest.hasCredentials ? "" : " · no credentials (public data only)"} · LLM ${ctx.llm ? "configured" : "not configured"} · transcripts ${ctx.transcripts ? "configured" : "none"}`,
    s.halted ? `⚠️ halted: ${escapeHtml(s.haltReason ?? "")}` : "",
    s.paused ? "⏸ paused by operator" : "",
    report.rulesOverridden.length
      ? `Limits adjusted from exchange: ${escapeHtml(report.rulesOverridden.join(", "))}`
      : "",
  ].filter(Boolean);
  void ctx.notifier.notify("warn", lines.join("\n"));
  insertEvent(
    ctx.db,
    "info",
    "startup",
    {
      version: ctx.version,
      mode: s.tradingMode,
      report,
      backfilled: kvGet(ctx.db, KV.marketBackfilled) !== null,
    },
    now,
  );
  log.info({ report, mode: s.tradingMode, version: ctx.version }, "startup checks complete");
  return report;
}
