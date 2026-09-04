import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Logger } from "@surf/core";
import { postTradeReview } from "@surf/agents";
import { escapeHtml } from "@surf/telegram";
import type { AppContext } from "../context.js";
import { schema } from "../db/index.js";
import {
  activeLessons,
  closedCount,
  closedPositions,
  getPosition,
  insertEvent,
  retireLesson,
} from "../db/queries.js";
import { journalOf, outcomeForPosition } from "../analytics/bridge.js";

export const LESSON_REVIEW_INTERVAL_TRADES = 10;

/**
 * Lesson retirement rule (v1): once the closed-trade count passes `reviewAfterTrades`, look at every
 * closed trade since the lesson was created; if their average realized R is <= 0 the lesson did not
 * help and is retired. Otherwise its review point moves 10 trades out. Simple and documented.
 */
export function retireStaleLessons(ctx: AppContext, log: Logger): string[] {
  const now = ctx.now();
  const total = closedCount(ctx.db);
  const retired: string[] = [];
  for (const l of activeLessons(ctx.db)) {
    if (total < l.reviewAfterTrades) continue;
    const since = closedPositions(ctx.db).filter(
      (p) => (p.closedAt ?? 0) >= l.createdAt && p.realizedR !== null,
    );
    const avgR = since.length ? since.reduce((s, p) => s + (p.realizedR ?? 0), 0) / since.length : 0;
    if (since.length > 0 && avgR <= 0) {
      retireLesson(ctx.db, l.id, `avg R ${avgR.toFixed(2)} over ${since.length} trades since creation`, now);
      retired.push(l.id);
      log.info({ lessonId: l.id, avgR }, "lesson retired");
    } else {
      ctx.db
        .update(schema.lessons)
        .set({ reviewAfterTrades: total + LESSON_REVIEW_INTERVAL_TRADES })
        .where(eq(schema.lessons.id, l.id))
        .run();
    }
  }
  return retired;
}

export interface PostTradePayload {
  positionId: string;
}

/** Loop D. Code computes the facts; the reviewer classifies and proposes at most one lesson. */
export async function runPostTradeReview(
  ctx: AppContext,
  payload: PostTradePayload,
  log: Logger,
): Promise<unknown> {
  const now = ctx.now();
  const p = getPosition(ctx.db, payload.positionId);
  if (!p) return { skipped: "unknown position" };
  if (p.status !== "closed") return { skipped: `position status ${p.status}` };
  const existing = ctx.db
    .select()
    .from(schema.tradeReviews)
    .where(eq(schema.tradeReviews.positionId, p.id))
    .get();
  if (existing) return { skipped: "already reviewed" };

  const openedAt = p.openedAt ?? p.createdAt;
  const closedAt = p.closedAt ?? now;
  const candles = ctx.md.getSeries("strike", "1h").range(openedAt - 3_600_000, closedAt);
  const { facts } = outcomeForPosition(p, candles, ctx.limits.priceTick);
  const journal = {
    ...journalOf(p),
    closedAt,
    filledPrice: p.entryPrice ?? journalOf(p).filledPrice ?? null,
  };
  const lessons = activeLessons(ctx.db);

  if (!ctx.llm) {
    ctx.db
      .insert(schema.tradeReviews)
      .values({ positionId: p.id, review: { skipped: "no LLM client", facts }, createdAt: now })
      .run();
    retireStaleLessons(ctx, log);
    return { positionId: p.id, terminal: "blocked", facts };
  }
  const r = await postTradeReview(
    { client: ctx.llm, model: ctx.models.analyst },
    { journalEntry: journal, outcomeFacts: facts, activeLessons: lessons.map((l) => l.text) },
  );
  ctx.state.recordLlmSpend(r.usage.costUsd);
  ctx.db
    .insert(schema.tradeReviews)
    .values({
      positionId: p.id,
      review: { ...r.output, facts, model: r.model, promptHash: r.promptHash },
      createdAt: now,
    })
    .run();
  let lessonId: string | null = null;
  if (r.output.lesson) {
    lessonId = randomUUID().slice(0, 8);
    ctx.db
      .insert(schema.lessons)
      .values({
        id: lessonId,
        text: r.output.lesson.text,
        evidence: r.output.lesson.evidenceTradeIds,
        status: "active",
        createdAt: now,
        reviewAfterTrades: closedCount(ctx.db) + LESSON_REVIEW_INTERVAL_TRADES,
      })
      .run();
  }
  const retired = retireStaleLessons(ctx, log);
  insertEvent(
    ctx.db,
    "info",
    "post-trade-review",
    {
      positionId: p.id,
      decisionQuality: r.output.decisionQuality,
      failureMode: r.output.failureMode,
      lessonId,
      retired,
    },
    now,
  );
  void ctx.notifier.notify(
    "info",
    [
      `📝 <b>Post-trade review</b> · trade <code>${escapeHtml(p.id)}</code> · ${escapeHtml(r.output.outcome)} · decision ${escapeHtml(r.output.decisionQuality)}${r.output.failureMode ? ` · ${escapeHtml(r.output.failureMode)}` : ""}`,
      escapeHtml(r.output.summary),
      r.output.lesson ? `<b>Lesson</b> ${escapeHtml(r.output.lesson.text)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return {
    positionId: p.id,
    terminal: "reviewed",
    decisionQuality: r.output.decisionQuality,
    lessonId,
    retired,
    costUsd: r.usage.costUsd,
  };
}
