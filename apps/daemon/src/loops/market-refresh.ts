import type { Logger } from "@surf/core";
import { kvGet, kvSet, schema } from "../db/index.js";
import { KV } from "../db/queries.js";
import type { AppContext } from "../context.js";

/** Persist the funding and open-interest points the market-data service holds in memory. */
export function persistStats(ctx: AppContext): { funding: number; openInterest: number } {
  const symbol = ctx.symbol;
  const funding = ctx.md.funding().slice(-2000);
  const oi = ctx.md.openInterest().slice(-2000);
  ctx.db.transaction((tx) => {
    const CHUNK = 300;
    for (let i = 0; i < funding.length; i += CHUNK) {
      tx.insert(schema.funding)
        .values(funding.slice(i, i + CHUNK).map((f) => ({ symbol, time: f.ts, rateHourly: f.fundingRate })))
        .onConflictDoNothing()
        .run();
    }
    for (let i = 0; i < oi.length; i += CHUNK) {
      tx.insert(schema.openInterest)
        .values(oi.slice(i, i + CHUNK).map((o) => ({ symbol, time: o.ts, value: o.openInterest })))
        .onConflictDoNothing()
        .run();
    }
  });
  return { funding: funding.length, openInterest: oi.length };
}

export async function marketRefresh(ctx: AppContext, log: Logger): Promise<unknown> {
  const now = ctx.now();
  let backfilled = false;
  if (!kvGet(ctx.db, KV.marketBackfilled)) {
    const summary = await ctx.md.backfill();
    if (summary.errors.length === 0 || summary.strike.fetched > 0 || summary.coinbase.fetched > 0) {
      kvSet(
        ctx.db,
        KV.marketBackfilled,
        { at: now, strike: summary.strike.fetched, coinbase: summary.coinbase.fetched },
        now,
      );
      backfilled = true;
    }
    log.info(
      { strike: summary.strike.fetched, coinbase: summary.coinbase.fetched, errors: summary.errors.length },
      "market backfill",
    );
  }
  const r = await ctx.md.refresh(now);
  const stats = persistStats(ctx);
  const check = r.crossCheck;
  kvSet(ctx.db, KV.lastCrossCheck, check, now);
  if (check && !check.ok) {
    log.warn({ check }, "market data cross-check failed");
    ctx.health.markFeed(
      "market-data",
      "degraded",
      `cross-check: ${check.reason ?? "deviation"} ${check.deviationPct?.toFixed(2) ?? ""}%`,
      now,
    );
  } else if (r.errors.length > 0) {
    ctx.health.markFeed("market-data", "degraded", r.errors.map((e) => e.source).join(", "), now);
  } else {
    ctx.health.markFeed("market-data", "ok", null, now);
  }
  for (const e of r.errors)
    log.warn({ source: e.source, err: String(e.error) }, "market refresh source failed");
  return {
    backfilled,
    newCandles: r.newCandles,
    strikeLatestClosed: r.strikeLatestClosed?.openTime ?? null,
    crossCheck: check,
    errors: r.errors.map((e) => e.source),
    persisted: stats,
  };
}
