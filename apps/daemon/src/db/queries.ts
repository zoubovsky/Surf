import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AnalystPrior, EwAnalysis, Interval } from "@surf/core";
import { kvGet, kvSet, schema, type Db } from "./index.js";

export type PositionRow = typeof schema.positions.$inferSelect;
export type OrderRow = typeof schema.orders.$inferSelect;
export type CycleRow = typeof schema.cycles.$inferSelect;
export type LessonRow = typeof schema.lessons.$inferSelect;
export type SignalRow = typeof schema.signals.$inferSelect;
export type VideoRow = typeof schema.videos.$inferSelect;
export type EventRow = typeof schema.events.$inferSelect;
export type StageRow = typeof schema.stages.$inferSelect;

/* ---------- positions ---------- */

export function positionsByStatus(db: Db, statuses: string[]): PositionRow[] {
  return db
    .select()
    .from(schema.positions)
    .where(inArray(schema.positions.status, statuses))
    .orderBy(asc(schema.positions.createdAt))
    .all();
}

export function livePositions(db: Db): PositionRow[] {
  return positionsByStatus(db, ["resting", "open"]);
}

export function openPosition(db: Db): PositionRow | null {
  return positionsByStatus(db, ["open"])[0] ?? null;
}

export function restingPositions(db: Db): PositionRow[] {
  return positionsByStatus(db, ["resting"]);
}

export function getPosition(db: Db, id: string): PositionRow | null {
  return db.select().from(schema.positions).where(eq(schema.positions.id, id)).get() ?? null;
}

export function updatePosition(
  db: Db,
  id: string,
  patch: Partial<Omit<PositionRow, "id" | "createdAt" | "updatedAt">>,
  now: number,
): void {
  db.update(schema.positions)
    .set({ ...patch, updatedAt: now })
    .where(eq(schema.positions.id, id))
    .run();
}

/** Closed positions with `closedAt >= from`, newest first. */
export function closedPositions(db: Db, from = 0): PositionRow[] {
  return db
    .select()
    .from(schema.positions)
    .where(and(eq(schema.positions.status, "closed"), gte(schema.positions.closedAt, from)))
    .orderBy(desc(schema.positions.closedAt))
    .all();
}

export function closedCount(db: Db): number {
  const r = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.positions)
    .where(eq(schema.positions.status, "closed"))
    .get();
  return r?.n ?? 0;
}

/* ---------- orders ---------- */

export function ordersForPosition(db: Db, positionId: string): OrderRow[] {
  return db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.positionId, positionId))
    .orderBy(asc(schema.orders.placedAt))
    .all();
}

export function getOrder(db: Db, clientOrderId: string): OrderRow | null {
  return db.select().from(schema.orders).where(eq(schema.orders.clientOrderId, clientOrderId)).get() ?? null;
}

export function updateOrder(
  db: Db,
  clientOrderId: string,
  patch: Partial<Omit<OrderRow, "clientOrderId" | "placedAt">>,
  now: number,
): void {
  db.update(schema.orders)
    .set({ ...patch, updatedAt: now })
    .where(eq(schema.orders.clientOrderId, clientOrderId))
    .run();
}

export function updateOrdersForPosition(
  db: Db,
  positionId: string,
  roles: string[],
  patch: Partial<Omit<OrderRow, "clientOrderId" | "placedAt">>,
  now: number,
): void {
  db.update(schema.orders)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(schema.orders.positionId, positionId), inArray(schema.orders.role, roles)))
    .run();
}

/* ---------- lessons ---------- */

export function activeLessons(db: Db): LessonRow[] {
  return db
    .select()
    .from(schema.lessons)
    .where(eq(schema.lessons.status, "active"))
    .orderBy(asc(schema.lessons.createdAt))
    .all();
}

export function retireLesson(db: Db, id: string, reason: string, now: number): void {
  db.update(schema.lessons)
    .set({ status: "retired", retiredAt: now, retiredReason: reason })
    .where(eq(schema.lessons.id, id))
    .run();
}

/* ---------- signals ---------- */

/** Newest analyst prior published within `maxAgeHours`, or null. */
export function latestPrior(db: Db, now: number, maxAgeHours: number): AnalystPrior | null {
  const row = db
    .select()
    .from(schema.signals)
    .where(
      and(isNotNull(schema.signals.prior), gte(schema.signals.publishedAt, now - maxAgeHours * 3_600_000)),
    )
    .orderBy(desc(schema.signals.publishedAt))
    .limit(1)
    .get();
  return row ? (row.prior as AnalystPrior) : null;
}

export function signalsCreatedAfter(db: Db, ts: number): number {
  const r = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.signals)
    .where(and(isNotNull(schema.signals.prior), sql`${schema.signals.createdAt} > ${ts}`))
    .get();
  return r?.n ?? 0;
}

/* ---------- ew counts ---------- */

export function latestEwCount(db: Db, interval: Interval): { asOf: number; analysis: EwAnalysis } | null {
  const row = db
    .select()
    .from(schema.ewCounts)
    .where(eq(schema.ewCounts.interval, interval))
    .orderBy(desc(schema.ewCounts.asOf))
    .limit(1)
    .get();
  return row ? { asOf: row.asOf, analysis: row.analysis as EwAnalysis } : null;
}

export function ewCountsSince(
  db: Db,
  interval: Interval,
  from: number,
): { asOf: number; analysis: EwAnalysis }[] {
  return db
    .select()
    .from(schema.ewCounts)
    .where(and(eq(schema.ewCounts.interval, interval), gte(schema.ewCounts.asOf, from)))
    .orderBy(asc(schema.ewCounts.asOf))
    .all()
    .map((r) => ({ asOf: r.asOf, analysis: r.analysis as EwAnalysis }));
}

/* ---------- cycles / stages ---------- */

export function latestCycle(db: Db): CycleRow | null {
  return db.select().from(schema.cycles).orderBy(desc(schema.cycles.startedAt)).limit(1).get() ?? null;
}

export function recentCycles(db: Db, n: number): CycleRow[] {
  return db.select().from(schema.cycles).orderBy(desc(schema.cycles.startedAt)).limit(n).all();
}

export function stageRow(db: Db, cycleId: string, stage: string): StageRow | null {
  return (
    db
      .select()
      .from(schema.stages)
      .where(and(eq(schema.stages.cycleId, cycleId), eq(schema.stages.stage, stage)))
      .get() ?? null
  );
}

export interface StageMeta {
  model?: string | null;
  usage?: unknown;
  costUsd?: number;
}

/**
 * Crash-safe stage checkpoint: if the stage already completed for this cycle, return the stored
 * output without running `fn`. Otherwise run it, persist the output (or the failure) and return it.
 * `fn` may return `{ output, meta }` to attach model/usage/cost to the row.
 */
export async function stageCheckpoint<T>(
  db: Db,
  cycleId: string,
  stage: string,
  now: () => number,
  fn: () => Promise<{ output: T; meta?: StageMeta } | T>,
): Promise<{ output: T; cached: boolean }> {
  const existing = stageRow(db, cycleId, stage);
  if (existing && existing.status === "done") return { output: existing.output as T, cached: true };
  const startedAt = now();
  try {
    const raw = await fn();
    const wrapped =
      raw !== null && typeof raw === "object" && "output" in (raw as object) && "meta" in (raw as object)
        ? (raw as { output: T; meta?: StageMeta })
        : { output: raw as T, meta: undefined };
    const meta = wrapped.meta ?? {};
    const row = {
      cycleId,
      stage,
      status: "done",
      output: wrapped.output ?? null,
      model: meta.model ?? null,
      usage: meta.usage ?? null,
      costUsd: meta.costUsd ?? 0,
      startedAt,
      finishedAt: now(),
      error: null,
    };
    db.insert(schema.stages)
      .values(row)
      .onConflictDoUpdate({ target: [schema.stages.cycleId, schema.stages.stage], set: row })
      .run();
    return { output: wrapped.output, cached: false };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const row = {
      cycleId,
      stage,
      status: "failed",
      output: null,
      model: null,
      usage: null,
      costUsd: 0,
      startedAt,
      finishedAt: now(),
      error: message.slice(0, 2000),
    };
    db.insert(schema.stages)
      .values(row)
      .onConflictDoUpdate({ target: [schema.stages.cycleId, schema.stages.stage], set: row })
      .run();
    throw err;
  }
}

/* ---------- events ---------- */

export function insertEvent(
  db: Db,
  level: "info" | "warn" | "critical",
  kind: string,
  payload: unknown,
  at: number,
): void {
  db.insert(schema.events).values({ at, level, kind, payload }).run();
}

export function eventsBetween(db: Db, from: number, to: number, kinds?: string[]): EventRow[] {
  const conds = [gte(schema.events.at, from), lte(schema.events.at, to)];
  if (kinds && kinds.length) conds.push(inArray(schema.events.kind, kinds));
  return db
    .select()
    .from(schema.events)
    .where(and(...conds))
    .orderBy(asc(schema.events.at))
    .all();
}

/** Equity readings recorded by the monitor, ascending. */
export function equitySeries(db: Db, from: number, to: number): { at: number; equity: number }[] {
  return eventsBetween(db, from, to, ["equity"]).map((e) => ({
    at: e.at,
    equity: Number((e.payload as { equity?: number } | null)?.equity ?? 0),
  }));
}

export function pruneEvents(db: Db, kinds: string[], olderThan: number): number {
  return db
    .delete(schema.events)
    .where(and(inArray(schema.events.kind, kinds), lte(schema.events.at, olderThan)))
    .run().changes;
}

/* ---------- kv convenience ---------- */

export interface LastCycleInfo {
  id: string;
  kind: string;
  at: number;
  terminal: string;
  /** True when the LLM stages ran. */
  llm: boolean;
  topCandidate: { id: string; position: string } | null;
}

export const KV = {
  lastCycle: "last-cycle",
  lastLlmCycleAt: "last-llm-cycle-at",
  lastTopCandidate: "last-top-candidate",
  lastMonitor: "last-monitor",
  lastBrief: "last-brief",
  lastBriefAt: "last-brief-at",
  marketBackfilled: "market-backfilled",
  shadowEquity: "shadow-equity",
  shadowExchange: "shadow-exchange",
  lastAccount: "last-account",
  positionsCard: "positions-card",
  lastCrossCheck: "last-cross-check",
  lastVideoDecisionAt: "last-video-decision-at",
  strikeFillCursor: "strike-fill-cursor",
} as const;

export function getLastCycle(db: Db): LastCycleInfo | null {
  return kvGet<LastCycleInfo>(db, KV.lastCycle);
}

export function setLastCycle(db: Db, info: LastCycleInfo, now: number): void {
  kvSet(db, KV.lastCycle, info, now);
  if (info.llm) kvSet(db, KV.lastLlmCycleAt, info.at, now);
}
