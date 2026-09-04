import type { EwAnalysis, RiskDecision, ReviewVerdict, TradePlan } from "@surf/core";
import { answerQuestion } from "@surf/agents";
import { escapeHtml, formatPaused, formatResumed } from "@surf/telegram";
import type {
  OpenOrderView,
  PnlRange,
  PnlReport,
  PositionsView,
  StatusReport,
  TelegramPorts,
  TradeExplanation,
  FeedHealth,
} from "@surf/telegram";
import type { AppContext } from "../context.js";
import { kvGet, schema } from "../db/index.js";
import {
  KV,
  closedPositions,
  equitySeries,
  eventsBetween,
  getLastCycle,
  getPosition,
  latestEwCount,
  livePositions,
  recentCycles,
  updateOrdersForPosition,
  updatePosition,
  type PositionRow,
} from "../db/queries.js";
import { journalOf } from "../analytics/bridge.js";
import { takeSnapshots } from "../loops/snapshots.js";
import { openOrderViews } from "./views.js";
import { eq } from "drizzle-orm";

const DAY = 86_400_000;

export function rangeStart(range: PnlRange, now: number, tz: string): number {
  if (range === "all") return 0;
  if (range === "7d") return now - 7 * DAY;
  if (range === "30d") return now - 30 * DAY;
  // today: local midnight in tz
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const sinceMidnightMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - sinceMidnightMs;
}

/** Max peak-to-trough drawdown (percent) of an equity series. */
export function maxDrawdownPct(series: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of series) {
    if (e > peak) peak = e;
    if (peak > 0) worst = Math.max(worst, ((peak - e) / peak) * 100);
  }
  return worst;
}

/** PnL report for a range from the closed positions rows and the recorded equity series. */
export function pnlReport(
  ctx: AppContext,
  range: PnlRange,
  currentEquity: number | null,
  unrealized: number,
): PnlReport {
  const now = ctx.now();
  const from = rangeStart(range, now, ctx.config.TZ);
  const rows = closedPositions(ctx.db, from);
  const realizedUsd = rows.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  const feesUsd = rows.reduce((s, p) => s + p.fees, 0);
  const fundingPaid = rows.reduce((s, p) => s + p.fundingPaid, 0);
  const rs = rows.map((p) => p.realizedR).filter((r): r is number => r !== null);
  const series = equitySeries(ctx.db, from, now).map((e) => e.equity);
  const endEquity =
    currentEquity ?? series.at(-1) ?? kvGet<{ equity: number }>(ctx.db, KV.lastAccount)?.equity ?? 0;
  if (currentEquity !== null) series.push(currentEquity);
  // realizedPnl is already net of fees and funding; report gross realized so net = realized - fees + funding(signed) stays consistent.
  const grossRealized = realizedUsd + feesUsd + fundingPaid;
  const netUsd = grossRealized + unrealized - feesUsd - fundingPaid;
  const startEquity = series[0] ?? Math.max(0, endEquity - netUsd);
  return {
    range,
    asOf: now,
    from,
    startEquity: Math.max(0, startEquity),
    endEquity: Math.max(0, endEquity),
    realizedUsd: grossRealized,
    unrealizedUsd: unrealized,
    feesUsd,
    fundingUsd: -fundingPaid,
    netUsd,
    netPct: startEquity > 0 ? (netUsd / startEquity) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(series),
    trades: rows.length,
    wins: rows.filter((p) => (p.realizedPnl ?? 0) > 0).length,
    losses: rows.filter((p) => (p.realizedPnl ?? 0) < 0).length,
    avgR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    bestR: rs.length ? Math.max(...rs) : null,
    worstR: rs.length ? Math.min(...rs) : null,
    rows: rows.slice(0, 20).map((p) => ({
      tradeId: p.id,
      closedAt: p.closedAt ?? now,
      direction: p.direction as "long" | "short",
      setup: journalOf(p).setup ?? null,
      realizedUsd: p.realizedPnl ?? 0,
      realizedR: p.realizedR,
    })),
  };
}

export function explainTrade(ctx: AppContext, p: PositionRow): TradeExplanation {
  const j = journalOf(p);
  const proposal = p.proposalId
    ? ctx.db.select().from(schema.proposals).where(eq(schema.proposals.id, p.proposalId)).get()
    : undefined;
  const plan = proposal?.plan as TradePlan | undefined;
  const review = proposal?.review as ReviewVerdict | null | undefined;
  const risk = proposal?.risk as RiskDecision | null | undefined;
  const events = eventsBetween(ctx.db, p.createdAt - 1000, ctx.now())
    .filter((e) => JSON.stringify(e.payload ?? {}).includes(p.id))
    .slice(0, 30)
    .map((e) => ({ at: e.at, kind: e.kind, detail: JSON.stringify(e.payload).slice(0, 200) }));
  return {
    tradeId: p.id,
    symbol: p.symbol,
    direction: p.direction as "long" | "short",
    setup: j.setup ?? null,
    candidateId: j.candidateId ?? null,
    priorVideoId: j.priorVideoId ?? null,
    openedAt: p.openedAt ?? p.createdAt,
    closedAt: p.closedAt,
    entryPrice: p.entryPrice ?? p.plannedEntry ?? p.stopLoss,
    size: p.size,
    leverage: p.leverage,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    exitPrice: p.exitPrice,
    realizedUsd: p.realizedPnl,
    realizedR: p.realizedR,
    confidence: j.reviewerConfidence ?? plan?.confidence ?? "medium",
    reviewVerdict: review?.verdict ?? "approve",
    reviewReasons: review?.reasons ?? j.reviewerReasons ?? [],
    riskSummary: risk?.summary ?? "n/a",
    evidence: j.evidence ?? [],
    rationale: j.rationale ?? plan?.rationale ?? "",
    events,
  };
}

/** The daemon's implementation of the Telegram contract, entirely from the DB and services. */
export function createPorts(ctx: AppContext): TelegramPorts {
  const positionsView = async (): Promise<PositionsView> => {
    const { account, market } = await takeSnapshots(ctx);
    const view = await ctx.executor.view(ctx.symbol, ctx.now() - 7 * DAY);
    return { account, market, orders: openOrderViews(ctx.db, view) };
  };
  return {
    async getPnl(range) {
      let equity: number | null = null;
      let unrealized = 0;
      try {
        const a = await ctx.executor.account(ctx.symbol, ctx.now());
        equity = a.equity;
        unrealized = a.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
      } catch {
        /* fall back to the recorded series */
      }
      return pnlReport(ctx, range, equity, unrealized);
    },
    getPositions: positionsView,
    async getOpenOrders(): Promise<OpenOrderView[]> {
      const view = await ctx.executor.view(ctx.symbol, ctx.now() - 7 * DAY);
      return openOrderViews(ctx.db, view);
    },
    getBrief() {
      return kvGet<string>(ctx.db, KV.lastBrief) ?? "<i>No brief yet.</i>";
    },
    getWhy(tradeId) {
      const p = getPosition(ctx.db, tradeId.trim());
      return p ? explainTrade(ctx, p) : null;
    },
    getCount(): EwAnalysis | null {
      return latestEwCount(ctx.db, "1h")?.analysis ?? null;
    },
    getStatus(): StatusReport {
      const now = ctx.now();
      const s = ctx.state.get();
      const last = getLastCycle(ctx.db);
      const feeds: FeedHealth[] = [
        "strike-rest",
        "strike-ws",
        "market-data",
        "youtube-feed",
        "transcripts",
        "llm",
      ].map((name) => {
        const f = ctx.health.feeds.get(name);
        const detail =
          name === "strike-ws" && ctx.executor.mode === "shadow"
            ? "not used in shadow mode"
            : name === "llm" && !ctx.llm
              ? "no ANTHROPIC_API_KEY"
              : (f?.detail ?? null);
        const health =
          name === "strike-ws" && ctx.executor.mode === "shadow" ? "unknown" : (f?.health ?? "unknown");
        return { name, health, lastEventAt: f?.lastEventAt ?? null, detail };
      });
      const live = livePositions(ctx.db);
      return {
        asOf: now,
        mode: s.tradingMode,
        paused: s.paused,
        halted: s.halted,
        haltReason: s.haltReason,
        haltedAt: s.haltedAt,
        startedAt: ctx.startedAt,
        symbol: ctx.symbol,
        lastCandleCloseTime: ctx.md.latestClosed("1h", "strike")?.closeTime ?? null,
        lastCycleAt: last?.at ?? null,
        lastCycleTerminal: last?.terminal ?? null,
        feeds,
        lastError: ctx.health.lastError,
        llmSpendTodayUsd: s.llmSpendTodayUsd,
        llmBudgetUsd: ctx.limits.dailyLlmBudgetUsd,
        openPositions: live.filter((p) => p.status === "open").length,
        openOrders: live.filter((p) => p.status === "resting").length,
        entriesToday: s.entriesToday,
        consecutiveStopOuts: s.consecutiveStopOuts,
        version: ctx.version,
      };
    },
    getLimits() {
      return ctx.limits;
    },
    async pause({ flatten }) {
      const now = ctx.now();
      ctx.state.pause();
      const notes: string[] = [];
      if (flatten) {
        for (const p of livePositions(ctx.db)) {
          try {
            if (p.status === "open") {
              updatePosition(ctx.db, p.id, { exitReason: "manual" }, now);
              await ctx.executor.flatten(p, "operator pause");
              notes.push(`flattened ${p.id}`);
            } else {
              await ctx.executor.cancelResting(p);
              updatePosition(ctx.db, p.id, { status: "cancelled", exitReason: "manual", closedAt: now }, now);
              updateOrdersForPosition(
                ctx.db,
                p.id,
                ["entry", "stop", "take-profit"],
                { status: "cancelled" },
                now,
              );
              notes.push(`cancelled resting ${p.id}`);
            }
          } catch (err) {
            notes.push(`FAILED ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        ctx.runner.enqueue("monitor-tick", { singletonKey: `monitor-pause-${now}`, maxAttempts: 1 });
      }
      void ctx.notifier.notify(
        "warn",
        formatPaused({ flatten, at: now, ...(notes.length ? { detail: notes.join("; ") } : {}) }),
      );
      return flatten
        ? `Paused new entries and flattened: ${notes.join("; ") || "nothing open"}.`
        : "Paused new entries. Open positions and stops keep being managed.";
    },
    resume() {
      const now = ctx.now();
      const wasHalted = ctx.state.get().halted;
      ctx.state.resume();
      void ctx.notifier.notify(
        "warn",
        formatResumed({
          at: now,
          by: "operator",
          ...(wasHalted ? { detail: "automatic halt cleared" } : {}),
        }),
      );
      return wasHalted
        ? "Resumed. Automatic halt cleared; new entries enabled."
        : "Resumed. New entries enabled.";
    },
    async answerQuestion(text) {
      if (!ctx.llm)
        return "Q&amp;A is unavailable: no ANTHROPIC_API_KEY configured. Use /status, /pnl, /positions, /count, /why &lt;id&gt;.";
      const now = ctx.now();
      let positions: Record<string, unknown>[] = [];
      let pnl: Record<string, number> = {};
      try {
        const a = await ctx.executor.account(ctx.symbol, now);
        positions = a.openPositions.map((p) => ({ ...p }));
        const r = pnlReport(
          ctx,
          "30d",
          a.equity,
          a.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0),
        );
        pnl = {
          equity: a.equity,
          net30dUsd: r.netUsd,
          realized30dUsd: r.realizedUsd,
          trades30d: r.trades,
          wins: r.wins,
          losses: r.losses,
        };
      } catch {
        /* read-only context stays partial */
      }
      const recentDecisions = recentCycles(ctx.db, 30)
        .filter((c) => c.terminal)
        .map((c) => {
          const proposal = ctx.db
            .select()
            .from(schema.proposals)
            .where(eq(schema.proposals.cycleId, c.id))
            .get();
          const plan = proposal?.plan as TradePlan | undefined;
          const review = proposal?.review as ReviewVerdict | null | undefined;
          return {
            at: c.startedAt,
            action: plan?.action ?? "none",
            direction: plan?.direction ?? null,
            candidateId: plan?.candidateId ?? null,
            reviewerVerdict: review?.verdict ?? null,
            terminal: c.terminal ?? "unknown",
            summary: (c.summary ?? "").slice(0, 600),
          };
        });
      const r = await answerQuestion(
        { client: ctx.llm, model: ctx.models.researcher },
        {
          question: text.slice(0, 2000),
          context: { asOf: now, positions, pnl, recentDecisions, limits: ctx.limits },
        },
      );
      ctx.state.recordLlmSpend(r.usage.costUsd);
      return escapeHtml(r.output);
    },
  };
}
