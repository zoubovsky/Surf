import { createHash } from "node:crypto";
import type { Candle, Direction, Logger } from "@surf/core";
import {
  formatExit,
  formatFill,
  formatHalt,
  formatPositions,
  formatResumed,
  formatStopMoved,
  escapeHtml,
} from "@surf/telegram";
import type { AppContext } from "../context.js";
import { kvGet, kvSet } from "../db/index.js";
import {
  KV,
  insertEvent,
  livePositions,
  pruneEvents,
  updateOrder,
  updateOrdersForPosition,
  updatePosition,
  type PositionRow,
} from "../db/queries.js";
import { journalOf, outcomeForPosition } from "../analytics/bridge.js";
import { roleOfClientOrderId, type ExchangeFill, type ExchangeView } from "../execution/executor.js";
import { openOrderViews } from "../telegram/views.js";

const HOUR = 3_600_000;
export const CARD_MIN_INTERVAL_MS = 5 * 60_000;
export const RECONCILIATION_HALT = "reconciliation mismatch";

export interface MonitorResult {
  mark: number | null;
  filled: string[];
  closed: string[];
  cancelled: string[];
  flattened: string[];
  stopsMoved: string[];
  halted: string | null;
  mismatch: boolean;
}

function fillsFor(view: ExchangeView, positionId: string): ExchangeFill[] {
  return view.fills.filter((f) => roleOfClientOrderId(f.clientOrderId)?.positionId === positionId);
}

function vwap(fills: ExchangeFill[]): number | null {
  const size = fills.reduce((s, f) => s + f.size, 0);
  if (size <= 0) return null;
  return fills.reduce((s, f) => s + f.price * f.size, 0) / size;
}

function exitReasonFromFills(fills: ExchangeFill[]): string | null {
  for (const f of fills) {
    const r = roleOfClientOrderId(f.clientOrderId)?.role;
    if (r === "stop") return "stop";
    if (r === "take-profit") return "take-profit";
    if (r === "exit") return "flatten";
  }
  return null;
}

/** Candles overlapping the holding period, from the execution venue (fallback Coinbase). */
function holdingCandles(ctx: AppContext, openedAt: number, closedAt: number): Candle[] {
  const s = ctx.md.getSeries("strike", "1h");
  const from = openedAt - HOUR;
  const rows = s.range(from, closedAt);
  if (rows.length > 0) return rows;
  return ctx.md.getSeries("coinbase", "1h").range(from, closedAt);
}

async function closePosition(
  ctx: AppContext,
  p: PositionRow,
  view: ExchangeView,
  mark: number,
  log: Logger,
): Promise<void> {
  const now = ctx.now();
  const fills = fillsFor(view, p.id);
  const exitFills = fills.filter((f) => roleOfClientOrderId(f.clientOrderId)?.role !== "entry");
  const exitPrice = vwap(exitFills) ?? mark;
  const exitReason = p.exitReason ?? exitReasonFromFills(exitFills) ?? "manual";
  const fees = fills.reduce((s, f) => s + f.fee, 0);
  const fundingPaid = await ctx.executor.fundingPaid(p);
  const closedAt = exitFills.at(-1)?.time ?? now;
  const openedAt = p.openedAt ?? p.createdAt;
  const patched: PositionRow = { ...p, exitPrice, exitReason, fees, fundingPaid, closedAt, openedAt };
  const { code } = outcomeForPosition(patched, holdingCandles(ctx, openedAt, closedAt), ctx.limits.priceTick);
  updatePosition(
    ctx.db,
    p.id,
    {
      status: "closed",
      exitPrice,
      exitReason,
      fees,
      fundingPaid,
      closedAt,
      openedAt,
      realizedPnl: code.netPnl,
      realizedR: code.realizedR,
      mae: code.maeR,
      mfe: code.mfeR,
    },
    now,
  );
  for (const f of exitFills) {
    const role = roleOfClientOrderId(f.clientOrderId)?.role;
    const clientOrderId =
      role === "stop" ? `surf-${p.id}-sl` : role === "take-profit" ? `surf-${p.id}-tp` : `surf-${p.id}-exit`;
    updateOrder(
      ctx.db,
      clientOrderId,
      { status: "filled", filledSize: f.size, avgFillPrice: f.price, exchangeOrderId: f.orderId },
      now,
    );
  }
  const filledRoles = new Set(exitFills.map((f) => roleOfClientOrderId(f.clientOrderId)?.role));
  updateOrdersForPosition(
    ctx.db,
    p.id,
    ["stop", "take-profit"].filter((r) => !filledRoles.has(r as "stop" | "take-profit")),
    { status: "cancelled" },
    now,
  );
  ctx.state.recordExit(code.realizedR, exitReason);
  insertEvent(
    ctx.db,
    "warn",
    "position-closed",
    { positionId: p.id, exitPrice, exitReason, realizedR: code.realizedR, netPnl: code.netPnl },
    now,
  );
  ctx.runner.enqueue("post-trade-review", {
    singletonKey: `post-trade-${p.id}`,
    payload: { positionId: p.id },
    maxAttempts: 3,
  });
  void ctx.notifier.notify(
    "warn",
    formatExit({
      tradeId: p.id,
      symbol: p.symbol,
      direction: p.direction as Direction,
      entryPrice: p.entryPrice ?? p.plannedEntry ?? exitPrice,
      exitPrice,
      size: p.size,
      realizedUsd: code.netPnl,
      realizedR: code.realizedR,
      reason: exitReason,
      openedAt,
      closedAt,
    }),
  );
  log.info({ positionId: p.id, exitReason, realizedR: code.realizedR }, "position closed");
}

/**
 * Loop C: code only. Reconciles DB positions with the exchange (or the shadow simulator), applies
 * invalidation flattening and breakeven stops, tracks equity and halts, heartbeats, live card.
 */
export async function monitorTick(ctx: AppContext, log: Logger): Promise<MonitorResult> {
  const now = ctx.now();
  const symbol = ctx.symbol;
  const result: MonitorResult = {
    mark: null,
    filled: [],
    closed: [],
    cancelled: [],
    flattened: [],
    stopsMoved: [],
    halted: null,
    mismatch: false,
  };

  // (0) prices
  let mark: number | null = null;
  let fundingRate = 0;
  try {
    const pi = await ctx.rest.premiumIndex(symbol);
    mark = pi.markPrice;
    fundingRate = pi.fundingRate;
    ctx.health.markFeed("strike-rest", "ok", null, now);
  } catch (err) {
    const cached = ctx.md.premiumIndex();
    ctx.health.markFeed("strike-rest", "degraded", err instanceof Error ? err.message : String(err), now);
    log.warn({ err: String(err) }, "premiumIndex unavailable; using cached");
    if (cached) {
      mark = cached.markPrice;
      fundingRate = cached.fundingRate;
    }
  }
  if (mark === null) {
    insertEvent(ctx.db, "warn", "heartbeat", { skipped: "no mark price" }, now);
    kvSet(ctx.db, KV.lastMonitor, now, now);
    return result;
  }
  result.mark = mark;
  if (ctx.executor.simulate) {
    // Shadow fills depend on the in-progress bar's range; pull it fresh instead of waiting for the 15-min refresh.
    try {
      const fresh = await ctx.rest.klines({ symbol, interval: "1h", priceType: "index", limit: 2 });
      if (fresh.length) ctx.md.getSeries("strike", "1h").upsert(fresh);
    } catch (err) {
      log.warn({ err: String(err) }, "fresh kline unavailable; using cached bar");
    }
  }
  const candle =
    ctx.md.getSeries("strike", "1h").latest() ?? ctx.md.getSeries("coinbase", "1h").latest() ?? null;
  ctx.executor.simulate?.({ mark, candle, fundingRateHourly: fundingRate, now });

  // (a) reconcile
  const tracked = livePositions(ctx.db);
  const since = Math.min(now - 7 * 86_400_000, ...tracked.map((p) => p.createdAt));
  const view = await ctx.executor.view(symbol, since);
  const claimed = new Set<number>();
  for (const p of tracked) {
    const idx = view.positions.findIndex(
      (x, i) => !claimed.has(i) && x.symbol === p.symbol && x.direction === p.direction,
    );
    const exPos = idx >= 0 ? view.positions[idx]! : null;
    if (exPos) claimed.add(idx);
    const fills = fillsFor(view, p.id);
    if (p.status === "resting") {
      const entryFills = fills.filter((f) => roleOfClientOrderId(f.clientOrderId)?.role === "entry");
      const entryOrderOpen = view.openOrders.some(
        (o) => roleOfClientOrderId(o.clientOrderId)?.positionId === p.id && !o.reduceOnly,
      );
      if (exPos || entryFills.length > 0) {
        const entryPrice = vwap(entryFills) ?? exPos?.entryPrice ?? p.plannedEntry ?? mark;
        const openedAt = entryFills.at(-1)?.time ?? now;
        const fees = entryFills.reduce((s, f) => s + f.fee, 0);
        updatePosition(
          ctx.db,
          p.id,
          {
            status: "open",
            entryPrice,
            openedAt,
            fees,
            journal: { ...journalOf(p), openedAt, filledPrice: entryPrice },
          },
          now,
        );
        updateOrder(
          ctx.db,
          `surf-${p.id}-entry`,
          { status: "filled", filledSize: p.size, avgFillPrice: entryPrice },
          now,
        );
        updateOrdersForPosition(ctx.db, p.id, ["stop", "take-profit"], { status: "open" }, now);
        insertEvent(ctx.db, "warn", "entry-filled", { positionId: p.id, entryPrice, openedAt }, now);
        void ctx.notifier.notify(
          "warn",
          formatFill({
            tradeId: p.id,
            symbol: p.symbol,
            direction: p.direction as Direction,
            role: "entry",
            price: entryPrice,
            size: p.size,
            at: openedAt,
            feeUsd: fees,
          }),
        );
        result.filled.push(p.id);
        // A stop/TP may already have fired in the same bar (shadow same-bar rule or a fast live move).
        if (!exPos) {
          const refreshed = { ...p, status: "open", entryPrice, openedAt } as PositionRow;
          await closePosition(ctx, refreshed, view, mark, log);
          result.closed.push(p.id);
        }
      } else if (!entryOrderOpen && ctx.executor.mode === "live") {
        updatePosition(ctx.db, p.id, { status: "cancelled", exitReason: "expired", closedAt: now }, now);
        updateOrdersForPosition(ctx.db, p.id, ["entry", "stop", "take-profit"], { status: "cancelled" }, now);
        insertEvent(ctx.db, "warn", "resting-gone", { positionId: p.id }, now);
        void ctx.notifier.notify(
          "warn",
          `⚠️ Resting entry for trade <code>${p.id}</code> is no longer on the venue; marked cancelled.`,
        );
        result.cancelled.push(p.id);
      }
      continue;
    }
    // open
    if (!exPos) {
      await closePosition(ctx, p, view, mark, log);
      result.closed.push(p.id);
      continue;
    }
    // (b) invalidation flatten
    const j = journalOf(p);
    const inv = j.invalidation?.price ?? null;
    const dir = p.direction as Direction;
    if (
      inv !== null &&
      p.exitReason === null &&
      ((dir === "long" && mark <= inv) || (dir === "short" && mark >= inv))
    ) {
      updatePosition(ctx.db, p.id, { exitReason: "invalidation" }, now);
      await ctx.executor.flatten(p, "invalidation");
      insertEvent(
        ctx.db,
        "critical",
        "flatten",
        { positionId: p.id, reason: "invalidation", mark, invalidation: inv },
        now,
      );
      void ctx.notifier.notify(
        "warn",
        `🛑 <b>Invalidation breached</b> · trade <code>${p.id}</code>\nmark ${escapeHtml(String(mark))} crossed ${escapeHtml(String(inv))}; flattening.`,
      );
      result.flattened.push(p.id);
      continue;
    }
    // (c) breakeven
    const entry = p.entryPrice ?? exPos.entryPrice;
    const stopDist = Math.abs(entry - p.initialStop);
    const unrealized = (dir === "long" ? 1 : -1) * (mark - entry) * p.size;
    const atBreakeven = dir === "long" ? p.stopLoss >= entry : p.stopLoss <= entry;
    if (stopDist > 0 && !atBreakeven && p.exitReason === null && unrealized >= stopDist * p.size) {
      const tick = ctx.limits.priceTick;
      const newStop = dir === "long" ? entry + tick : entry - tick;
      try {
        await ctx.executor.moveStop(p, newStop);
        updatePosition(ctx.db, p.id, { stopLoss: newStop }, now);
        updateOrdersForPosition(ctx.db, p.id, ["stop"], { stopPrice: newStop }, now);
        insertEvent(
          ctx.db,
          "warn",
          "stop-moved",
          { positionId: p.id, from: p.stopLoss, to: newStop, reason: "breakeven at +1R" },
          now,
        );
        void ctx.notifier.notify(
          "warn",
          formatStopMoved({
            tradeId: p.id,
            symbol: p.symbol,
            from: p.stopLoss,
            to: newStop,
            reason: "breakeven at +1R",
            at: now,
          }),
        );
        result.stopsMoved.push(p.id);
      } catch (err) {
        log.error({ err: String(err), positionId: p.id }, "breakeven stop move failed");
      }
    }
  }
  // unknown exchange positions
  const unknown = view.positions.filter((_, i) => !claimed.has(i) && view.positions[i]!.symbol === symbol);
  if (unknown.length > 0) {
    result.mismatch = true;
    const s = ctx.state.get();
    if (!(s.halted && s.haltReason === RECONCILIATION_HALT)) {
      ctx.state.halt(RECONCILIATION_HALT);
      result.halted = RECONCILIATION_HALT;
      void ctx.notifier.notify(
        "critical",
        formatHalt({
          reason: RECONCILIATION_HALT,
          at: now,
          detail: unknown.map((u) => `${u.direction} ${u.size} @ ${u.entryPrice} not in journal`).join("; "),
        }),
      );
    }
  }

  // (d) equity + auto-halt
  const account = await ctx.executor.account(symbol, now);
  const obs = ctx.state.observeEquity(account.equity);
  if (obs.reArmed) void ctx.notifier.notify("warn", formatResumed({ at: now, by: "cooldown" }));
  const haltReason = ctx.state.checkAutoHalt(account.equity);
  if (haltReason) {
    result.halted = haltReason;
    void ctx.notifier.notify(
      "critical",
      formatHalt({ reason: haltReason, at: now, resumesAt: now + ctx.limits.haltCooldownHours * HOUR }),
    );
    for (const p of livePositions(ctx.db).filter((x) => x.status === "resting")) {
      try {
        await ctx.executor.cancelResting(p);
        updatePosition(ctx.db, p.id, { status: "cancelled", exitReason: "halt", closedAt: now }, now);
        updateOrdersForPosition(ctx.db, p.id, ["entry", "stop", "take-profit"], { status: "cancelled" }, now);
        result.cancelled.push(p.id);
      } catch (err) {
        log.error({ err: String(err), positionId: p.id }, "cancel on halt failed");
      }
    }
  }

  // (e) heartbeat + equity series
  const lastEquity = kvGet<{ equity: number }>(ctx.db, KV.lastAccount)?.equity;
  if (lastEquity === undefined || Math.abs(lastEquity - account.equity) >= 0.005)
    insertEvent(ctx.db, "info", "equity", { equity: account.equity }, now);
  kvSet(
    ctx.db,
    KV.lastAccount,
    {
      equity: account.equity,
      availableBalance: account.availableBalance,
      openPositions: account.openPositions.length,
      at: now,
    },
    now,
  );
  insertEvent(
    ctx.db,
    "info",
    "heartbeat",
    { mark, positions: view.positions.length, orders: view.openOrders.length },
    now,
  );
  kvSet(ctx.db, KV.lastMonitor, now, now);
  if (new Date(now).getUTCMinutes() === 0) pruneEvents(ctx.db, ["heartbeat"], now - 7 * 86_400_000);

  // (f) live card
  try {
    const orders = openOrderViews(ctx.db, view);
    const cardBody = JSON.stringify({
      p: account.openPositions,
      o: orders.map((o) => [o.orderId, o.price, o.triggerPrice, o.status]),
    });
    const hash = createHash("sha1").update(cardBody).digest("hex");
    const card = kvGet<{ hash: string; at: number }>(ctx.db, KV.positionsCard);
    if (
      (!card || card.hash !== hash) &&
      (!card || now - card.at >= CARD_MIN_INTERVAL_MS) &&
      (account.openPositions.length > 0 || orders.length > 0 || card)
    ) {
      const market = ctx.md.premiumIndex();
      const snapshot = {
        asOf: now,
        symbol,
        markPrice: mark,
        indexPrice: market?.indexPrice ?? mark,
        referencePrice: ctx.md.referencePrice(),
        bestBid: null,
        bestAsk: null,
        depthNotionalNear: null,
        fundingRateHourly: fundingRate,
        nextFundingTime: market?.nextFundingTime ?? null,
        lastCandleCloseTime: ctx.md.latestClosed("1h", "strike")?.closeTime ?? null,
      };
      void ctx.notifier.editOrSend("positions", formatPositions({ account, market: snapshot, orders }, now));
      kvSet(ctx.db, KV.positionsCard, { hash, at: now }, now);
    }
  } catch (err) {
    log.warn({ err: String(err) }, "positions card failed");
  }
  return result;
}

/** Enqueue an immediate monitor tick (used by the user stream on fills). */
export function requestMonitorTick(ctx: AppContext, reason: string): void {
  const now = ctx.now();
  ctx.runner.enqueue("monitor-tick", {
    singletonKey: `monitor-ws-${now}`,
    payload: { reason },
    maxAttempts: 1,
  });
}
