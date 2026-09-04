import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Candle, EwAnalysis, EwCandidate, Logger, RiskDecision, TerminalState } from "@surf/core";
import { evaluateRisk } from "@surf/core";
import { runDecisionStages, type DecisionInputs, type DecisionRun, type JournalEntry } from "@surf/agents";
import {
  formatDecision,
  formatError,
  formatHalt,
  formatOrderPlaced,
  formatStopMoved,
  escapeHtml,
} from "@surf/telegram";
import type { AppContext } from "../context.js";
import { kvGet, kvSet, schema } from "../db/index.js";
import {
  KV,
  activeLessons,
  getLastCycle,
  insertEvent,
  latestPrior,
  openPosition,
  restingPositions,
  setLastCycle,
  signalsCreatedAfter,
  stageCheckpoint,
  updateOrdersForPosition,
  updatePosition,
  type PositionRow,
} from "../db/queries.js";
import { calibrationForAgents, journalOf, openPositionContext } from "../analytics/bridge.js";
import { isWiderStop, StopWidenError } from "../execution/executor.js";
import { pregate, type PregateResult } from "./pregate.js";
import { takeSnapshots, type Snapshots } from "./snapshots.js";

export interface DecisionPayload {
  cycleId: string;
  kind?: "hourly" | "video";
  videoId?: string;
}

export interface DecisionOutcome {
  cycleId: string;
  terminal: TerminalState;
  summary: string;
  costUsd: number;
  positionId?: string;
}

export const PER_CYCLE_LLM_BUDGET_USD = 2;
const HOUR = 3_600_000;

export function newPositionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export function findCandidate(ew: { h1: EwAnalysis; h4: EwAnalysis }, id: string | null): EwCandidate | null {
  if (!id) return null;
  return ew.h1.candidates.find((c) => c.id === id) ?? ew.h4.candidates.find((c) => c.id === id) ?? null;
}

/** Cancel resting entries that outlived their TTL or whose justifying count no longer exists. */
export async function expireRestingEntries(
  ctx: AppContext,
  ew: { h1: EwAnalysis; h4: EwAnalysis } | null,
  log: Logger,
): Promise<string[]> {
  const now = ctx.now();
  const expired: string[] = [];
  for (const p of restingPositions(ctx.db)) {
    const bars = Math.floor((now - p.createdAt) / HOUR);
    let reason: string | null = null;
    if (bars >= ctx.config.RESTING_TTL_BARS)
      reason = `unfilled after ${bars} bars (ttl ${ctx.config.RESTING_TTL_BARS})`;
    else if (ew) {
      const j = journalOf(p);
      const c = findCandidate(ew, j.candidateId);
      if (!c || c.direction !== p.direction)
        reason = `candidate ${j.candidateId ?? "?"} no longer valid in latest analysis`;
    }
    if (!reason) continue;
    try {
      await ctx.executor.cancelResting(p);
    } catch (err) {
      log.error({ err: String(err), positionId: p.id }, "cancelResting failed; keeping row for reconcile");
      continue;
    }
    updatePosition(ctx.db, p.id, { status: "cancelled", exitReason: "expired", closedAt: now }, now);
    updateOrdersForPosition(ctx.db, p.id, ["entry", "stop", "take-profit"], { status: "cancelled" }, now);
    insertEvent(ctx.db, "info", "resting-expired", { positionId: p.id, reason }, now);
    void ctx.notifier.notify(
      "info",
      `⏳ <b>Resting entry cancelled</b> · trade <code>${p.id}</code>\n${escapeHtml(reason)}`,
    );
    expired.push(p.id);
  }
  return expired;
}

function candlesFor(ctx: AppContext, interval: "1h" | "4h", n: number): Candle[] {
  const cb = ctx.md.getCandles(interval, n, "coinbase");
  if (cb.length >= 50) return cb;
  const strike = ctx.md.getCandles(interval, n, "strike");
  return strike.length > cb.length ? strike : cb;
}

/**
 * Loop B. One decision cycle for the candle that just closed (or a fresh video signal). Every stage
 * is checkpointed in `stages`, so a crash mid-cycle resumes without paying the LLM twice.
 */
export async function runDecisionCycle(
  ctx: AppContext,
  payload: DecisionPayload,
  log: Logger,
): Promise<DecisionOutcome> {
  const { cycleId } = payload;
  const kind = payload.kind ?? "hourly";
  const startedAt = ctx.now();
  const checkpoint = <T>(
    stage: string,
    fn: () => Promise<{ output: T; meta?: { model?: string | null; usage?: unknown; costUsd?: number } } | T>,
  ) => stageCheckpoint(ctx.db, cycleId, stage, () => ctx.now(), fn);

  ctx.db
    .insert(schema.cycles)
    .values({ id: cycleId, kind, trigger: payload, startedAt })
    .onConflictDoNothing()
    .run();

  let costUsd = 0;
  const finish = (
    terminal: TerminalState,
    summary: string,
    extra: {
      llm?: boolean;
      topCandidate?: { id: string; position: string } | null;
      positionId?: string;
    } = {},
  ): DecisionOutcome => {
    const now = ctx.now();
    ctx.db
      .update(schema.cycles)
      .set({ finishedAt: now, terminal, summary: summary.slice(0, 2000), costUsd })
      .where(eq(schema.cycles.id, cycleId))
      .run();
    const prev = getLastCycle(ctx.db);
    setLastCycle(
      ctx.db,
      {
        id: cycleId,
        kind,
        at: now,
        terminal,
        llm: extra.llm ?? false,
        topCandidate: extra.topCandidate ?? prev?.topCandidate ?? null,
      },
      now,
    );
    insertEvent(
      ctx.db,
      terminal === "exhausted" || terminal === "failed" ? "warn" : "info",
      "cycle",
      { cycleId, kind, terminal, summary: summary.slice(0, 500), costUsd },
      now,
    );
    log.info({ cycleId, terminal, costUsd }, summary);
    const out: DecisionOutcome = { cycleId, terminal, summary, costUsd };
    if (extra.positionId) out.positionId = extra.positionId;
    return out;
  };

  // 1. Snapshots (always fresh) and equity bookkeeping.
  let snaps: Snapshots;
  try {
    snaps = await takeSnapshots(ctx);
  } catch (err) {
    ctx.health.markFeed("strike-rest", "down", err instanceof Error ? err.message : String(err), ctx.now());
    ctx.health.recordError("decision.snapshots", err, ctx.now());
    throw err;
  }
  const { account, market } = snaps;
  const observed = ctx.state.observeEquity(account.equity);
  if (observed.reArmed) void ctx.notifier.notify("warn", `🟢 <b>Automatic halt re-armed</b> after cooldown.`);
  const haltReason = ctx.state.checkAutoHalt(account.equity);
  if (haltReason) void ctx.notifier.notify("critical", formatHalt({ reason: haltReason, at: ctx.now() }));

  // 2. Deterministic EW analysis, persisted once per cycle.
  const ewStage = await checkpoint<{ h1: EwAnalysis; h4: EwAnalysis } | null>("ew", async () => {
    const h1 = candlesFor(ctx, "1h", 600);
    const h4 = candlesFor(ctx, "4h", 300);
    if (h1.length === 0 || h4.length === 0) return null;
    const r = ctx.analyzeEw({ h1, h4 });
    const asOf = ctx.now();
    ctx.db
      .insert(schema.ewCounts)
      .values([
        { cycleId, interval: "1h", asOf, analysis: r.h1 },
        { cycleId, interval: "4h", asOf, analysis: r.h4 },
      ])
      .run();
    return { h1: r.h1, h4: r.h4 };
  });
  const ew = ewStage.output;
  if (!ew) return finish("failed", "no candles available for EW analysis");
  const top = ew.h1.candidates[0] ?? null;
  const topRef = top ? { id: top.id, position: top.position } : null;

  // 3. Housekeeping on resting entries (runs even when the LLM is gated out).
  await expireRestingEntries(ctx, ew, log);
  const open = openPosition(ctx.db);
  const resting = restingPositions(ctx.db);

  // 4. Pre-gate.
  const prior = latestPrior(ctx.db, ctx.now(), ctx.config.PRIOR_MAX_AGE_HOURS);
  const last = getLastCycle(ctx.db);
  const lastLlmAt = kvGet<number>(ctx.db, KV.lastLlmCycleAt);
  const gate = await checkpoint<PregateResult>("pregate", async () =>
    pregate({
      kind,
      hasOpenPosition: open !== null || account.openPositions.length > 0,
      openDirection:
        (open?.direction as "long" | "short" | undefined) ?? account.openPositions[0]?.direction ?? null,
      hasRestingOrder: resting.length > 0,
      topCandidate: topRef,
      lastTopCandidate:
        kvGet<{ top: { id: string; position: string } | null }>(ctx.db, KV.lastTopCandidate)?.top ?? null,
      price: market.markPrice,
      entryZones: ew.h1.candidates.slice(0, 3).flatMap((c) => (c.entryZone ? [c.entryZone] : [])),
      newSignal: last ? signalsCreatedAfter(ctx.db, last.at) > 0 : prior !== null,
      fundingRateHourly: market.fundingRateHourly,
      maxAdverseFundingHourly: ctx.limits.maxAdverseFundingHourly,
      lastLlmCycleAt: lastLlmAt,
      now: ctx.now(),
    }),
  );
  kvSet(ctx.db, KV.lastTopCandidate, { top: topRef }, ctx.now());
  if (!gate.output.run)
    return finish("no-op", "pre-gate: nothing changed; LLM stages skipped", { topCandidate: topRef });

  if (!ctx.llm) {
    ctx.health.markFeed("llm", "down", "no ANTHROPIC_API_KEY", ctx.now());
    return finish(
      "blocked",
      `pre-gate fired (${gate.output.reasons.join("; ")}) but no LLM client is configured`,
      { topCandidate: topRef },
    );
  }
  const budget = Math.min(PER_CYCLE_LLM_BUDGET_USD, ctx.state.llmBudgetRemaining());
  if (budget < 0.05) {
    void ctx.notifier.notify(
      "warn",
      formatError({
        context: "decision",
        message: "daily LLM budget exhausted; cycle skipped",
        at: ctx.now(),
        terminal: "exhausted",
      }),
    );
    return finish("exhausted", "daily LLM budget exhausted", { topCandidate: topRef });
  }

  // 5. LLM stages (research -> analyze -> review), one checkpoint for the whole run plus per-stage rows.
  const inputs: DecisionInputs = {
    ew,
    prior,
    account,
    market,
    state: ctx.state.get(),
    limits: ctx.limits,
    calibration: calibrationForAgents(ctx.db, ctx.now()),
    lessons: activeLessons(ctx.db).map((l) => l.text),
    openPosition: open ? openPositionContext(open) : null,
    research: {
      funding: ctx.md
        .funding()
        .slice(-72)
        .map((f) => ({ time: f.ts, rateHourly: f.fundingRate })),
      openInterestHistory: ctx.md
        .openInterest()
        .slice(-72)
        .map((o) => ({ time: o.ts, openInterestUsd: Math.max(0, o.openInterest * market.markPrice) })),
      recentCloses: ctx.md.getCandles("1h", 24, "coinbase").map((c) => c.close),
    },
  };
  const llm = ctx.llm;
  const llmStage = await checkpoint<DecisionRun>("llm", async () => {
    const run = await runDecisionStages(
      {
        client: llm,
        models: ctx.models,
        budgetUsd: budget,
        priorMaxAgeHours: ctx.config.PRIOR_MAX_AGE_HOURS,
      },
      inputs,
    );
    for (const s of run.stages) {
      const row = {
        cycleId,
        stage: `llm:${s.stage}:${s.round}`,
        status: "done",
        output: s.output,
        model: s.model,
        usage: s.usage,
        costUsd: s.usage.costUsd,
        startedAt: ctx.now() - s.durationMs,
        finishedAt: ctx.now(),
        error: null,
      };
      ctx.db
        .insert(schema.stages)
        .values(row)
        .onConflictDoUpdate({ target: [schema.stages.cycleId, schema.stages.stage], set: row })
        .run();
    }
    ctx.state.recordLlmSpend(run.totalUsage.costUsd);
    return {
      output: run,
      meta: {
        model: run.stages.map((s) => s.model).join(","),
        usage: run.totalUsage,
        costUsd: run.totalUsage.costUsd,
      },
    };
  });
  const run = llmStage.output;
  costUsd = run.totalUsage.costUsd;
  ctx.health.markFeed("llm", "ok", null, ctx.now());
  const done = (terminal: TerminalState, summary: string, positionId?: string) =>
    finish(terminal, summary, { llm: true, topCandidate: topRef, ...(positionId ? { positionId } : {}) });

  if (run.terminal === "exhausted") {
    void ctx.notifier.notify(
      "warn",
      formatError({
        context: `decision ${cycleId}`,
        message: run.reason,
        at: ctx.now(),
        terminal: "exhausted",
      }),
    );
    return done("exhausted", run.reason);
  }
  const plan = run.plan;
  if (!plan) return done("failed", `no plan produced: ${run.reason}`);
  if (plan.action === "no-trade" || !run.review) {
    void ctx.notifier.notify(
      "info",
      `🧭 <b>Decision</b> ${escapeHtml(plan.action)} · ${escapeHtml(run.reason)}\n<i>${escapeHtml(plan.rationale.slice(0, 600))}</i>`,
    );
    return done(run.terminal === "rejected" ? "rejected" : "no-op", `${plan.action}: ${run.reason}`);
  }
  const review = run.review;

  // 6. Risk engine.
  const candidate = findCandidate(ew, plan.candidateId);
  const riskStage = await checkpoint<RiskDecision>("risk", async () => {
    const risk = evaluateRisk({
      plan,
      review,
      candidate,
      account,
      market,
      state: ctx.state.get(),
      limits: ctx.limits,
      now: ctx.now(),
    });
    ctx.db
      .insert(schema.proposals)
      .values({ id: `${cycleId}-p`, cycleId, plan, review, risk, createdAt: ctx.now() })
      .onConflictDoNothing()
      .run();
    return risk;
  });
  const risk = riskStage.output;
  const level =
    plan.action === "enter" || plan.action === "exit" || plan.action === "adjust-stop" ? "warn" : "info";
  void ctx.notifier.notify(level, formatDecision({ plan, review, risk, order: risk.order }));

  if (run.terminal === "rejected") return done("rejected", run.reason);

  // 7. Execution.
  if (plan.action === "enter") {
    if (risk.verdict !== "allow" || !risk.order) return done("blocked", risk.summary);
    const order = risk.order;
    const exec = await checkpoint<{ positionId: string; strategyId: string }>("execute", async () => {
      const positionId = newPositionId();
      const now = ctx.now();
      const journal: JournalEntry = {
        tradeId: positionId,
        openedAt: now,
        closedAt: null,
        direction: order.direction,
        setup: plan.setup,
        candidateId: plan.candidateId,
        priorVideoId: plan.priorVideoId,
        entryZone: plan.entry,
        entryKind: plan.entryKind,
        filledPrice: order.entryKind === "market" ? market.markPrice : null,
        stopLoss: { price: order.stopLoss, label: plan.stopLoss?.label ?? "stop" },
        takeProfit: { price: order.takeProfit, label: plan.takeProfit?.label ?? "target" },
        invalidation: candidate?.invalidation ?? null,
        analystConfidence: plan.confidence,
        reviewerConfidence: review.adjustedConfidence,
        reviewerReasons: review.reasons,
        priorDisagrees: plan.priorDisagrees,
        rationale: plan.rationale,
        evidence: plan.evidence,
        paramsVersion: "v1",
        knowledgeVersion: null,
        modelIds: Object.fromEntries(run.stages.map((s) => [`${s.stage}:${s.round}`, s.model])),
        promptHashes: Object.fromEntries(run.stages.map((s) => [`${s.stage}:${s.round}`, s.promptHash])),
      };
      const isMarket = order.entryKind === "market";
      ctx.db
        .insert(schema.positions)
        .values({
          id: positionId,
          cycleId,
          proposalId: `${cycleId}-p`,
          symbol: order.symbol,
          direction: order.direction,
          size: order.size,
          entryPrice: isMarket ? market.markPrice : null,
          plannedEntry: order.entryPrice,
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
          initialStop: order.stopLoss,
          leverage: order.leverage,
          riskUsd: order.riskUsd,
          status: isMarket ? "open" : "resting",
          openedAt: isMarket ? now : null,
          journal,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      let placed: { clientOrderId: string; strategyId: string };
      try {
        placed = await ctx.executor.placeBracket(order, {
          positionId,
          markPrice: market.markPrice,
          limitTakeBound: snaps.limitTakeBound,
          isFlat: account.openPositions.length === 0,
          now,
        });
      } catch (err) {
        ctx.db.delete(schema.positions).where(eq(schema.positions.id, positionId)).run();
        throw err;
      }
      const side = order.direction === "long" ? "buy" : "sell";
      const exitSide = side === "buy" ? "sell" : "buy";
      ctx.db
        .insert(schema.orders)
        .values([
          {
            clientOrderId: `surf-${positionId}-entry`,
            strategyId: placed.strategyId,
            cycleId,
            proposalId: `${cycleId}-p`,
            positionId,
            symbol: order.symbol,
            side,
            type: order.entryKind,
            role: "entry",
            size: order.size,
            price: isMarket ? null : order.entryPrice,
            stopPrice: null,
            status: isMarket ? "filled" : "open",
            filledSize: isMarket ? order.size : 0,
            avgFillPrice: isMarket ? market.markPrice : null,
            placedAt: now,
            updatedAt: now,
            raw: null,
          },
          {
            clientOrderId: `surf-${positionId}-sl`,
            strategyId: placed.strategyId,
            cycleId,
            proposalId: `${cycleId}-p`,
            positionId,
            symbol: order.symbol,
            side: exitSide,
            type: "stop",
            role: "stop",
            size: order.size,
            price: null,
            stopPrice: order.stopLoss,
            status: isMarket ? "open" : "untriggered",
            filledSize: 0,
            avgFillPrice: null,
            placedAt: now,
            updatedAt: now,
            raw: null,
          },
          {
            clientOrderId: `surf-${positionId}-tp`,
            strategyId: placed.strategyId,
            cycleId,
            proposalId: `${cycleId}-p`,
            positionId,
            symbol: order.symbol,
            side: exitSide,
            type: "take_profit",
            role: "take-profit",
            size: order.size,
            price: null,
            stopPrice: order.takeProfit,
            status: isMarket ? "open" : "untriggered",
            filledSize: 0,
            avgFillPrice: null,
            placedAt: now,
            updatedAt: now,
            raw: null,
          },
        ])
        .run();
      ctx.state.recordEntry();
      insertEvent(
        ctx.db,
        "warn",
        "order-placed",
        { positionId, cycleId, order, strategyId: placed.strategyId },
        now,
      );
      void ctx.notifier.notify(
        "warn",
        formatOrderPlaced({
          tradeId: positionId,
          order,
          mode: ctx.executor.mode,
          orderId: placed.strategyId,
        }),
      );
      return { positionId, strategyId: placed.strategyId };
    });
    return done(risk.terminal, `${risk.summary} (trade ${exec.output.positionId})`, exec.output.positionId);
  }

  if (plan.action === "exit" || plan.action === "adjust-stop") {
    if (review.verdict !== "approve")
      return done("rejected", `reviewer did not approve ${plan.action}: ${review.reasons[0] ?? ""}`);
    const target: PositionRow | null = openPosition(ctx.db);
    if (!target) return done("no-op", `${plan.action} requested but no open position`);
    const exec = await checkpoint<{ action: string; detail: string }>("execute", async () => {
      const now = ctx.now();
      if (plan.action === "exit") {
        updatePosition(ctx.db, target.id, { exitReason: "flatten" }, now);
        await ctx.executor.flatten(target, "analyst exit");
        insertEvent(
          ctx.db,
          "warn",
          "flatten",
          { positionId: target.id, reason: "analyst exit", cycleId },
          now,
        );
        return { action: "exit", detail: `flattened ${target.id}` };
      }
      const newStop = plan.newStop?.price;
      if (newStop === undefined) return { action: "adjust-stop", detail: "no newStop in plan" };
      if (isWiderStop(target.direction as "long" | "short", target.stopLoss, newStop)) {
        log.warn({ positionId: target.id, from: target.stopLoss, to: newStop }, "rejected stop widening");
        insertEvent(
          ctx.db,
          "warn",
          "stop-widen-rejected",
          { positionId: target.id, from: target.stopLoss, to: newStop },
          now,
        );
        return {
          action: "adjust-stop",
          detail: `rejected: ${newStop} would widen the stop from ${target.stopLoss}`,
        };
      }
      try {
        await ctx.executor.moveStop(target, newStop);
      } catch (err) {
        if (err instanceof StopWidenError) return { action: "adjust-stop", detail: err.message };
        throw err;
      }
      updatePosition(ctx.db, target.id, { stopLoss: newStop }, now);
      updateOrdersForPosition(ctx.db, target.id, ["stop"], { stopPrice: newStop }, now);
      insertEvent(
        ctx.db,
        "warn",
        "stop-moved",
        { positionId: target.id, from: target.stopLoss, to: newStop, reason: "analyst adjust-stop" },
        now,
      );
      void ctx.notifier.notify(
        "warn",
        formatStopMoved({
          tradeId: target.id,
          symbol: target.symbol,
          from: target.stopLoss,
          to: newStop,
          reason: plan.newStop?.label ?? "analyst adjust-stop",
          at: now,
        }),
      );
      return { action: "adjust-stop", detail: `stop ${target.stopLoss} -> ${newStop}` };
    });
    return done(plan.action === "exit" ? "traded" : "hold", exec.output.detail);
  }

  return done("hold", `hold: ${run.reason}`);
}
