import type { Logger, MarketContext } from "@surf/core";
import { dailyBrief, type DailyBriefInput } from "@surf/agents";
import { escapeHtml, formatCount, formatDailyBrief, formatPnl, type BriefSection } from "@surf/telegram";
import type { AppContext } from "../context.js";
import { kvSet } from "../db/index.js";
import { KV, latestEwCount, latestPrior, recentCycles, restingPositions, stageRow } from "../db/queries.js";
import { calibrationForAgents } from "../analytics/bridge.js";
import type { TelegramPorts } from "@surf/telegram";
import { takeSnapshots } from "./snapshots.js";

/** Latest researcher context stored by a decision cycle, if any. */
export function latestMarketContext(ctx: AppContext): MarketContext | null {
  for (const c of recentCycles(ctx.db, 48)) {
    const row = stageRow(ctx.db, c.id, "llm");
    const out = row?.output as { context?: MarketContext | null } | null;
    if (out?.context) return out.context;
  }
  return null;
}

export async function buildBriefInput(ctx: AppContext, ports: TelegramPorts): Promise<DailyBriefInput> {
  const now = ctx.now();
  const { account, market } = await takeSnapshots(ctx);
  const [today, d7, d30] = await Promise.all([
    ports.getPnl("today"),
    ports.getPnl("7d"),
    ports.getPnl("30d"),
  ]);
  const prior = latestPrior(ctx.db, now, ctx.config.PRIOR_MAX_AGE_HOURS * 4);
  const count = latestEwCount(ctx.db, "1h");
  const context = latestMarketContext(ctx);
  const s = ctx.state.get();
  const resting = restingPositions(ctx.db);
  return {
    asOf: now,
    timezone: ctx.config.TZ,
    positions: account.openPositions.map((p) => ({
      direction: p.direction,
      size: p.size,
      entryPrice: p.entryPrice,
      markPrice: market.markPrice,
      unrealizedPnlUsd: p.unrealizedPnl,
      stopLoss: null,
      takeProfit: null,
    })),
    restingOrders: resting.map((p) => ({
      direction: p.direction as "long" | "short",
      price: p.plannedEntry ?? 0,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      expiresAt: p.createdAt + ctx.config.RESTING_TTL_BARS * 3_600_000,
    })),
    pnl: { todayUsd: today.netUsd, d7Usd: d7.netUsd, d30Usd: d30.netUsd, equityUsd: account.equity },
    latestPrior: prior
      ? {
          title: prior.title,
          publishedAt: prior.publishedAt,
          bias: prior.bias,
          primaryCount: prior.primaryCount,
          invalidation: prior.invalidation?.price ?? null,
        }
      : null,
    ownCount: (count?.analysis.candidates ?? []).slice(0, 3).map((c) => ({
      id: c.id,
      interval: c.interval,
      direction: c.direction,
      position: c.position,
      invalidation: c.invalidation.price,
      score: c.score,
    })),
    regime: {
      regime: context?.regime ?? "unclear",
      fundingRateHourly: market.fundingRateHourly,
      fundingAssessment: context?.fundingAssessment ?? "neutral",
      openInterestTrend: context?.openInterestTrend ?? "unknown",
    },
    events: (context?.eventRisk ?? []).filter((e) => e.when >= now).slice(0, 10),
    calibration: calibrationForAgents(ctx.db, now),
    llmSpend: { todayUsd: s.llmSpendTodayUsd, budgetUsd: ctx.limits.dailyLlmBudgetUsd },
    health: {
      tradingMode: s.tradingMode,
      paused: s.paused,
      halted: s.halted,
      haltReason: s.haltReason,
      lastError: ctx.health.lastError
        ? `${ctx.health.lastError.context}: ${ctx.health.lastError.message}`
        : null,
    },
  };
}

/** Daily brief: model prose (Sonnet) when available, plus code-rendered PnL and count tables. */
export async function runDailyBrief(ctx: AppContext, ports: TelegramPorts, log: Logger): Promise<unknown> {
  const now = ctx.now();
  const input = await buildBriefInput(ctx, ports);
  const sections: BriefSection[] = [];
  let costUsd = 0;
  if (ctx.llm) {
    try {
      const r = await dailyBrief({ client: ctx.llm, model: ctx.models.researcher }, input);
      ctx.state.recordLlmSpend(r.usage.costUsd);
      costUsd = r.usage.costUsd;
      sections.push({ title: "Summary", body: escapeHtml(r.output) });
    } catch (err) {
      log.error({ err: String(err) }, "daily brief model call failed; sending code sections only");
      ctx.health.recordError("daily-brief", err, now);
    }
  }
  const pnl = await ports.getPnl("today");
  sections.push({ title: "PnL", body: formatPnl(pnl) });
  const count = latestEwCount(ctx.db, "1h");
  if (count) sections.push({ title: "Own count (1h)", body: formatCount(count.analysis) });
  if (input.latestPrior) {
    const p = input.latestPrior;
    sections.push({
      title: "Latest MCO thesis",
      body: `${escapeHtml(p.title)} · ${p.bias ?? "no bias"}\n${escapeHtml(p.primaryCount)}${p.invalidation !== null ? `\nInvalidation ${p.invalidation}` : ""}`,
    });
  }
  sections.push({
    title: "System",
    body: `mode ${input.health.tradingMode}${input.health.paused ? " · paused" : ""}${input.health.halted ? ` · HALTED (${escapeHtml(input.health.haltReason ?? "")})` : ""} · LLM spend today $${input.llmSpend.todayUsd.toFixed(2)} / $${input.llmSpend.budgetUsd}${input.health.lastError ? `\nLast error: ${escapeHtml(input.health.lastError)}` : ""}`,
  });
  const html = formatDailyBrief(sections, new Date(now));
  kvSet(ctx.db, KV.lastBrief, html, now);
  kvSet(ctx.db, KV.lastBriefAt, now, now);
  void ctx.notifier.notify("warn", html);
  return { sections: sections.map((s) => s.title), costUsd, llm: ctx.llm !== null };
}
