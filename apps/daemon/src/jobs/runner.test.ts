import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { JobRunner } from "./runner.js";
import { createLogger } from "@surf/core";

function setup(now: { t: number }) {
  const { db } = openDb({ path: ":memory:" });
  const runner = new JobRunner({ db, log: createLogger("silent"), now: () => now.t, backoffBaseMs: 1000 });
  return { db, runner };
}

describe("JobRunner", () => {
  it("runs a queued job and marks it done", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    let ran = 0;
    runner.register("hello", async () => {
      ran++;
      return { ok: true };
    });
    expect(runner.enqueue("hello")).toBeTruthy();
    expect(await runner.tick()).toBe(true);
    expect(ran).toBe(1);
    expect(runner.stats().done).toBe(1);
    expect(await runner.tick()).toBe(false);
  });

  it("dedupes singleton keys while queued or running, allows after done", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    runner.register("hourly", async () => null);
    expect(runner.enqueue("hourly", { singletonKey: "hourly-2026-09-04T13" })).toBeTruthy();
    expect(runner.enqueue("hourly", { singletonKey: "hourly-2026-09-04T13" })).toBeNull();
    await runner.tick();
    // a done job keeps its singleton key so the same cycle is never re-run
    expect(runner.enqueue("hourly", { singletonKey: "hourly-2026-09-04T13" })).toBeNull();
    expect(runner.enqueue("hourly", { singletonKey: "hourly-2026-09-04T14" })).toBeTruthy();
  });

  it("does not run jobs before runAt", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    runner.register("later", async () => null);
    runner.enqueue("later", { runAt: now.t + 5000 });
    expect(await runner.tick()).toBe(false);
    now.t += 5000;
    expect(await runner.tick()).toBe(true);
  });

  it("retries with backoff then dead-letters", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    let calls = 0;
    runner.register("flaky", async () => {
      calls++;
      throw new Error("boom");
    });
    runner.enqueue("flaky", { maxAttempts: 2 });
    expect(await runner.tick()).toBe(true);
    expect(runner.stats().queued).toBe(1);
    expect(await runner.tick()).toBe(false); // backoff not elapsed
    now.t += 1000;
    expect(await runner.tick()).toBe(true);
    expect(calls).toBe(2);
    expect(runner.stats().dead).toBe(1);
  });

  it("recovers orphaned running jobs at startup", async () => {
    const now = { t: 1_000_000 };
    const { db, runner } = setup(now);
    runner.register("slow", async () => null);
    const id = runner.enqueue("slow")!;
    db.run(`update jobs set status='running', locked_at=${now.t - 60_000} where id='${id}'` as never);
    expect(runner.recoverOrphans()).toBe(1);
    expect(runner.stats().queued).toBe(1);
  });

  it("dead-letters jobs with no handler", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    runner.enqueue("unknown");
    await runner.tick();
    expect(runner.stats().dead).toBe(1);
  });

  it("prunes old done jobs", async () => {
    const now = { t: 1_000_000 };
    const { runner } = setup(now);
    runner.register("x", async () => null);
    runner.enqueue("x");
    await runner.tick();
    now.t += 10_000;
    expect(runner.prune(5_000)).toBe(1);
  });
});
