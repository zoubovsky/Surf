import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLogger } from "@surf/core";
import { schema } from "../db/index.js";
import { getPosition, livePositions } from "../db/queries.js";
import type { ShadowExecutor } from "../execution/shadow.js";
import { buildHarness, H, T0 } from "../testing/harness.js";
import { fakeLlm } from "../testing/fake-llm.js";
import { expireRestingEntries, runDecisionCycle } from "./decision.js";

const log = createLogger("silent");

async function ready(h: ReturnType<typeof buildHarness>) {
  await h.app.startup();
  await h.app.notifier.flush();
  h.tg!.sent.length = 0;
}

describe("decision cycle", () => {
  it("runs research -> analyze -> review -> risk -> shadow order and journals every stage", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0 });
    const h = buildHarness({ llm });
    await ready(h);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "hourly-test", kind: "video" }, log);
    expect(r.terminal).toBe("resting-placed");
    expect(r.positionId).toBeDefined();

    const cycle = h.db.select().from(schema.cycles).where(eq(schema.cycles.id, "hourly-test")).get()!;
    expect(cycle.terminal).toBe("resting-placed");
    expect(cycle.costUsd).toBeGreaterThan(0);
    const stages = h.db
      .select()
      .from(schema.stages)
      .where(eq(schema.stages.cycleId, "hourly-test"))
      .all()
      .map((s) => s.stage)
      .sort();
    expect(stages).toEqual([
      "ew",
      "execute",
      "llm",
      "llm:analyze:0",
      "llm:research:0",
      "llm:review:0",
      "pregate",
      "risk",
    ]);
    expect(
      h.db
        .select()
        .from(schema.ewCounts)
        .all()
        .map((e) => e.interval)
        .sort(),
    ).toEqual(["1h", "4h"]);
    const proposal = h.db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.cycleId, "hourly-test"))
      .get()!;
    expect((proposal.risk as { verdict: string }).verdict).toBe("allow");

    const pos = getPosition(h.db, r.positionId!)!;
    expect(pos.status).toBe("resting");
    expect(pos.direction).toBe("long");
    expect(pos.plannedEntry).toBe(78_900);
    expect(pos.stopLoss).toBe(76_800);
    expect(pos.takeProfit).toBe(83_500);
    expect(pos.size).toBeCloseTo(0.04761, 5);
    const journal = pos.journal as {
      tradeId: string;
      paramsVersion: string;
      invalidation: { price: number };
      modelIds: Record<string, string>;
    };
    expect(journal.tradeId).toBe(pos.id);
    expect(journal.paramsVersion).toBe("v1");
    expect(journal.invalidation.price).toBe(77_000);
    expect(Object.keys(journal.modelIds)).toEqual(["research:0", "analyze:0", "review:0"]);
    const orders = h.db.select().from(schema.orders).where(eq(schema.orders.positionId, pos.id)).all();
    expect(orders.map((o) => [o.clientOrderId, o.role, o.status])).toEqual([
      [`surf-${pos.id}-entry`, "entry", "open"],
      [`surf-${pos.id}-sl`, "stop", "untriggered"],
      [`surf-${pos.id}-tp`, "take-profit", "untriggered"],
    ]);
    const sim = (h.app.executor as ShadowExecutor).snapshot();
    expect(sim.orders.map((o) => o.clientOrderId)).toContain(`surf-${pos.id}-entry`);
    expect(h.app.ctx.state.get().entriesToday).toBe(1);
    await h.app.notifier.flush();
    const texts = h.tg!.texts();
    expect(texts.some((t) => t.includes("Decision") && t.includes("ENTER"))).toBe(true);
    expect(texts.some((t) => t.includes("Order placed") && t.includes("(SHADOW)"))).toBe(true);
  });

  it("resumes from stage checkpoints without calling the LLM again", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0 });
    const h = buildHarness({ llm });
    await ready(h);
    const first = await runDecisionCycle(h.app.ctx, { cycleId: "hourly-resume", kind: "video" }, log);
    const calls = llm.parseCalls.length + llm.runnerCalls.length;
    expect(calls).toBeGreaterThan(0);
    const second = await runDecisionCycle(h.app.ctx, { cycleId: "hourly-resume", kind: "video" }, log);
    expect(llm.parseCalls.length + llm.runnerCalls.length).toBe(calls);
    expect(second.positionId).toBe(first.positionId);
    expect(livePositions(h.db)).toHaveLength(1);
    expect(h.db.select().from(schema.ewCounts).all()).toHaveLength(2);
  });

  it("ends no-op for free when the pre-gate sees nothing new", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0 });
    const h = buildHarness({ llm, scenario: { mark: 79_780 } });
    await ready(h);
    // first hourly cycle: heartbeat + top-candidate change fire, so the LLM runs
    const r1 = await runDecisionCycle(h.app.ctx, { cycleId: "h1" }, log);
    expect(r1.terminal).toBe("resting-placed");
    // remove the resting order so nothing is open, then run the next hour
    const p = livePositions(h.db)[0]!;
    await h.app.executor.cancelResting(p);
    h.db.update(schema.positions).set({ status: "cancelled" }).where(eq(schema.positions.id, p.id)).run();
    const before = llm.parseCalls.length;
    h.advance(H);
    const r2 = await runDecisionCycle(h.app.ctx, { cycleId: "h2" }, log);
    expect(r2.terminal).toBe("no-op");
    expect(r2.summary).toMatch(/pre-gate/);
    expect(llm.parseCalls.length).toBe(before);
    expect(r2.costUsd).toBe(0);
  });

  it("reports blocked when the gate fires but no LLM client exists", async () => {
    const h = buildHarness({ llm: null });
    await ready(h);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "h-nollm", kind: "video" }, log);
    expect(r.terminal).toBe("blocked");
    expect(h.db.select().from(schema.cycles).where(eq(schema.cycles.id, "h-nollm")).get()!.terminal).toBe(
      "blocked",
    );
  });

  it("does not place an order when the reviewer rejects", async () => {
    const llm = fakeLlm({
      mark: 79_780,
      now: T0,
      verdict: {
        verdict: "reject",
        adjustedConfidence: "low",
        reasons: ["count is ambiguous"],
        severity: "major",
      },
    });
    const h = buildHarness({ llm });
    await ready(h);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "h-reject", kind: "video" }, log);
    expect(r.terminal).toBe("rejected");
    expect(livePositions(h.db)).toHaveLength(0);
    expect(h.db.select().from(schema.proposals).all()).toHaveLength(1);
  });

  it("blocks an entry the risk engine denies (stop inside the invalidation)", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0, plan: { stopLoss: { price: 78_000, label: "too tight" } } });
    const h = buildHarness({ llm });
    await ready(h);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "h-deny", kind: "video" }, log);
    expect(r.terminal).toBe("blocked");
    expect(r.summary).toMatch(/stop-beyond-invalidation/);
    expect(livePositions(h.db)).toHaveLength(0);
  });

  it("expires resting entries whose candidate vanished from the analysis", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0 });
    const h = buildHarness({ llm });
    await ready(h);
    await runDecisionCycle(h.app.ctx, { cycleId: "h-a", kind: "video" }, log);
    const p = livePositions(h.db)[0]!;
    const empty = (interval: "1h" | "4h") => ({
      symbol: "BTC-USD",
      interval,
      asOf: T0,
      lastClose: 79_780,
      swings: [],
      candidates: [],
      momentum: { rsi14: null, rsiDivergence: "none" as const, atr14: null },
    });
    h.app.ctx.analyzeEw = () => ({ h1: empty("1h"), h4: empty("4h"), h4Direction: null });
    h.advance(H);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "h-b" }, log);
    expect(getPosition(h.db, p.id)!.status).toBe("cancelled");
    expect(getPosition(h.db, p.id)!.exitReason).toBe("expired");
    expect(r.terminal).not.toBe("resting-placed");
  });
});

describe("expireRestingEntries", () => {
  async function withResting() {
    const llm = fakeLlm({ mark: 79_780, now: T0 });
    const h = buildHarness({ llm });
    await ready(h);
    const r = await runDecisionCycle(h.app.ctx, { cycleId: "hourly-exp", kind: "video" }, log);
    const p = getPosition(h.db, r.positionId!)!;
    expect(p.status).toBe("resting");
    const ew = h.app.ctx.analyzeEw({
      h1: h.app.ctx.md.getCandles("1h", 600, "coinbase"),
      h4: h.app.ctx.md.getCandles("4h", 300, "coinbase"),
    });
    return { h, p, ew: { h1: ew.h1, h4: ew.h4 } };
  }

  it("does not cancel when the candidate id changes but a same-direction candidate remains", async () => {
    const { h, p, ew } = await withResting();
    const renamed = {
      h1: { ...ew.h1, candidates: ew.h1.candidates.map((c) => ({ ...c, id: `${c.id}-renamed` })) },
      h4: { ...ew.h4, candidates: ew.h4.candidates.map((c) => ({ ...c, id: `${c.id}-renamed` })) },
    };
    const expired = await expireRestingEntries(h.app.ctx, renamed, log, 79_780);
    expect(expired).toEqual([]);
    expect(getPosition(h.db, p.id)!.status).toBe("resting");
  });

  it("cancels when the mark breaches the structural invalidation before the fill", async () => {
    const { h, p, ew } = await withResting();
    const inv = (p.journal as { invalidation: { price: number } | null }).invalidation!.price;
    const breach = p.direction === "long" ? inv - 1 : inv + 1;
    const expired = await expireRestingEntries(h.app.ctx, ew, log, breach);
    expect(expired).toEqual([p.id]);
    expect(getPosition(h.db, p.id)!.status).toBe("cancelled");
  });

  it("cancels when no same-direction candidate remains, and after the TTL", async () => {
    const { h, p, ew } = await withResting();
    const flipped = {
      h1: { ...ew.h1, candidates: ew.h1.candidates.filter((c) => c.direction !== p.direction) },
      h4: { ...ew.h4, candidates: ew.h4.candidates.filter((c) => c.direction !== p.direction) },
    };
    expect(await expireRestingEntries(h.app.ctx, flipped, log, 79_780)).toEqual([p.id]);

    const second = await withResting();
    second.h.advance((second.h.app.ctx.config.RESTING_TTL_BARS + 1) * H);
    expect(await expireRestingEntries(second.h.app.ctx, second.ew, log, 79_780)).toEqual([second.p.id]);
  });
});
