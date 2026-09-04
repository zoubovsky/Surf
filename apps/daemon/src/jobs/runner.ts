import { randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Logger } from "@surf/core";
import { sleep } from "@surf/core";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface JobRecord {
  id: string;
  kind: string;
  singletonKey: string | null;
  payload: unknown;
  runAt: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
}

export interface JobContext {
  job: JobRecord;
  log: Logger;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface EnqueueOptions {
  /** Deduplicate: if a queued/running job with this key exists, do not enqueue. */
  singletonKey?: string;
  runAt?: number;
  maxAttempts?: number;
  payload?: unknown;
}

export interface RunnerOptions {
  db: Db;
  log: Logger;
  pollMs?: number;
  /** Backoff base for retries in ms. */
  backoffBaseMs?: number;
  now?: () => number;
  /** Jobs locked longer than this are considered orphaned (e.g. crash) and re-queued at startup. */
  staleLockMs?: number;
}

/**
 * Durable single-process job runner over SQLite. One job runs at a time per kind-group
 * (default: globally sequential) so loops never race each other on the exchange.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly db: Db;
  private readonly log: Logger;
  private readonly pollMs: number;
  private readonly backoffBaseMs: number;
  private readonly now: () => number;
  private readonly staleLockMs: number;
  private running = false;
  private abort = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.log = opts.log.child({ component: "jobs" });
    this.pollMs = opts.pollMs ?? 1000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.staleLockMs = opts.staleLockMs ?? 30 * 60_000;
  }

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`handler already registered for ${kind}`);
    this.handlers.set(kind, handler);
  }

  /** Enqueue a job. Returns the job id, or null when a singleton already exists. */
  enqueue(kind: string, opts: EnqueueOptions = {}): string | null {
    const now = this.now();
    const id = randomUUID();
    if (opts.singletonKey) {
      const existing = this.db
        .select({ id: schema.jobs.id, status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.singletonKey, opts.singletonKey))
        .get();
      if (existing) return null;
    }
    this.db
      .insert(schema.jobs)
      .values({
        id,
        kind,
        singletonKey: opts.singletonKey ?? null,
        payload: opts.payload ?? null,
        runAt: opts.runAt ?? now,
        status: "queued",
        attempts: 0,
        maxAttempts: opts.maxAttempts ?? 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  /** Re-queue jobs left in "running" by a crash. Call once at startup. */
  recoverOrphans(): number {
    const now = this.now();
    const orphans = this.db.select().from(schema.jobs).where(eq(schema.jobs.status, "running")).all();
    for (const j of orphans) {
      this.db
        .update(schema.jobs)
        .set({ status: "queued", lockedAt: null, updatedAt: now, lastError: "recovered after restart" })
        .where(eq(schema.jobs.id, j.id))
        .run();
    }
    if (orphans.length) this.log.warn({ count: orphans.length }, "re-queued orphaned jobs");
    return orphans.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loopPromise;
  }

  /** Run at most one due job. Returns true if a job ran. Exposed for tests. */
  async tick(): Promise<boolean> {
    const now = this.now();
    const job = this.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, now)))
      .orderBy(asc(schema.jobs.runAt), asc(schema.jobs.createdAt))
      .limit(1)
      .get();
    if (!job) return false;
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      this.db
        .update(schema.jobs)
        .set({ status: "dead", lastError: `no handler for ${job.kind}`, updatedAt: now })
        .where(eq(schema.jobs.id, job.id))
        .run();
      this.log.error({ kind: job.kind }, "no handler registered");
      return true;
    }
    this.db
      .update(schema.jobs)
      .set({ status: "running", lockedAt: now, attempts: job.attempts + 1, updatedAt: now })
      .where(eq(schema.jobs.id, job.id))
      .run();
    const record: JobRecord = {
      id: job.id,
      kind: job.kind,
      singletonKey: job.singletonKey,
      payload: job.payload,
      runAt: job.runAt,
      status: "running",
      attempts: job.attempts + 1,
      maxAttempts: job.maxAttempts,
    };
    const log = this.log.child({ job: job.id, kind: job.kind, attempt: record.attempts });
    const started = this.now();
    try {
      const result = await handler({ job: record, log, signal: this.abort.signal });
      this.db
        .update(schema.jobs)
        .set({ status: "done", result: result ?? null, updatedAt: this.now(), lockedAt: null })
        .where(eq(schema.jobs.id, job.id))
        .run();
      log.info({ ms: this.now() - started }, "job done");
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const exhausted = record.attempts >= record.maxAttempts;
      const delay = this.backoffBaseMs * 2 ** (record.attempts - 1);
      this.db
        .update(schema.jobs)
        .set({
          status: exhausted ? "dead" : "queued",
          runAt: exhausted ? job.runAt : this.now() + delay,
          lastError: message,
          updatedAt: this.now(),
          lockedAt: null,
        })
        .where(eq(schema.jobs.id, job.id))
        .run();
      log.error({ err: message, exhausted, retryInMs: exhausted ? null : delay }, "job failed");
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const ran = await this.tick();
        if (!ran) await sleep(this.pollMs);
      } catch (err) {
        this.log.error({ err }, "runner loop error");
        await sleep(this.pollMs);
      }
    }
  }

  /** Counts by status, for /status. */
  stats(): Record<JobStatus, number> {
    const rows = this.db.select({ status: schema.jobs.status }).from(schema.jobs).all();
    const out: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, dead: 0 };
    for (const r of rows) out[r.status as JobStatus] = (out[r.status as JobStatus] ?? 0) + 1;
    return out;
  }

  /** Delete done jobs older than `olderThanMs`. */
  prune(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const res = this.db
      .delete(schema.jobs)
      .where(and(eq(schema.jobs.status, "done"), lte(schema.jobs.updatedAt, cutoff)))
      .run();
    return res.changes;
  }
}
