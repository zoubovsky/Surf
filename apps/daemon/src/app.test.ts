import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "./db/index.js";
import { getPosition, livePositions } from "./db/queries.js";
import { buildHarness, H, T0, VIDEO_ID, touchLastCandle } from "./testing/harness.js";
import { fakeLlm } from "./testing/fake-llm.js";

const MIN = 60_000;

/**
 * End-to-end in memory: startup -> market-refresh -> feed-poll -> video-ingest -> video decision cycle
 * -> shadow resting bracket -> monitor fills the entry -> monitor hits the target -> post-trade review
 * -> daily brief. Deterministic clock, fake Strike/Coinbase/YouTube/LLM/Telegram.
 */
describe("daemon end-to-end (shadow)", () => {
  it("runs the whole loop chain and leaves a consistent journal", async () => {
    const llm = fakeLlm({ mark: 79_780, now: T0, videoId: VIDEO_ID });
    const h = buildHarness({ llm });
    const { app, db, scenario, tg } = h;

    // --- startup
    const report = await app.startup();
    expect(report.ping).toBe(true);
    expect(report.reconciled).toBe(true);
    expect(report.equity).toBe(10_000);
    expect(report.backfill!.strike).toBeGreaterThan(500);
    await app.notifier.flush();
    expect(tg!.texts()[0]).toMatch(/Surf daemon started/);
    expect(tg!.texts()[0]).toMatch(/SHADOW/);
    expect(app.health().ok).toBe(true);

    // --- market refresh + feed poll
    app.runner.enqueue("market-refresh", { singletonKey: "mr-1", maxAttempts: 1 });
    app.runner.enqueue("feed-poll", { singletonKey: "fp-1", maxAttempts: 1 });
    expect(await h.drain()).toBe(2);
    expect(db.select().from(schema.funding).all().length).toBeGreaterThan(0);
    expect(db.select().from(schema.openInterest).all().length).toBeGreaterThan(0);
    const videos = db.select().from(schema.videos).all();
    expect(videos.filter((v) => v.status === "new").map((v) => v.videoId)).toContain(VIDEO_ID);
    expect(videos.some((v) => v.status === "not-relevant")).toBe(true); // ETH/SOL/XRP titles
    const ingestJob = db.select().from(schema.jobs).where(eq(schema.jobs.kind, "video-ingest")).all();
    expect(ingestJob.length).toBeGreaterThanOrEqual(1);
    expect(ingestJob[0]!.runAt).toBe(scenario.now + 10 * MIN);
    expect(tg!.texts().some((t) => t.includes("New MCO Bitcoin video detected"))).toBe(true);

    // --- video ingest is not due yet; after 10 minutes it runs, extracts the prior and enqueues a video cycle
    expect(await h.drain()).toBe(0);
    h.advance(10 * MIN);
    const ran = await h.drain();
    expect(ran).toBeGreaterThanOrEqual(2); // every Bitcoin video ingests; at least one decision cycle follows
    const signal = db.select().from(schema.signals).where(eq(schema.signals.videoId, VIDEO_ID)).get()!;
    expect(signal.prior).not.toBeNull();
    expect(db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "ingested",
    );
    expect(tg!.texts().some((t) => t.includes("Video ingested"))).toBe(true);

    // --- the video cycle placed a shadow resting bracket
    const cycles = db.select().from(schema.cycles).all();
    const traded = cycles.find((c) => c.terminal === "resting-placed");
    expect(traded, JSON.stringify(cycles.map((c) => [c.id, c.terminal, c.summary]))).toBeDefined();
    expect(traded!.kind).toBe("video");
    const stages = db.select().from(schema.stages).where(eq(schema.stages.cycleId, traded!.id)).all();
    expect(stages.map((s) => s.stage)).toEqual(
      expect.arrayContaining(["ew", "pregate", "llm", "risk", "execute"]),
    );
    expect(stages.every((s) => s.status === "done")).toBe(true);
    const live = livePositions(db);
    expect(live).toHaveLength(1);
    const pos = live[0]!;
    expect(pos.status).toBe("resting");
    expect(pos.plannedEntry).toBe(78_900);
    expect(
      db.select().from(schema.proposals).where(eq(schema.proposals.cycleId, traded!.id)).all(),
    ).toHaveLength(1);
    expect(db.select().from(schema.orders).where(eq(schema.orders.positionId, pos.id)).all()).toHaveLength(3);
    expect(tg!.texts().some((t) => t.includes("Order placed"))).toBe(true);
    // other Bitcoin videos from the same feed must not open a second position (one position at a time)
    expect(cycles.filter((c) => c.terminal === "resting-placed")).toHaveLength(1);

    // --- monitor: nothing touches the entry yet
    h.advance(MIN);
    app.runner.enqueue("monitor-tick", { singletonKey: "mt-1", maxAttempts: 1 });
    await h.drain();
    expect(getPosition(db, pos.id)!.status).toBe("resting");

    // --- monitor: the in-progress candle dips into the entry -> fill
    h.advance(MIN);
    touchLastCandle(scenario, { low: 78_500 });
    app.runner.enqueue("monitor-tick", { singletonKey: "mt-2", maxAttempts: 1 });
    await h.drain();
    let p = getPosition(db, pos.id)!;
    expect(p.status).toBe("open");
    expect(p.entryPrice).toBe(78_900);
    expect(p.openedAt).toBe(scenario.now);
    expect(tg!.texts().some((t) => t.includes("Entry filled"))).toBe(true);
    expect(
      db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.clientOrderId, `surf-${pos.id}-entry`))
        .get()!.status,
    ).toBe("filled");

    // --- next hour: a new bar spikes through the target -> take-profit
    h.advance(H);
    scenario.mark = 83_450;
    touchLastCandle(scenario, { high: 83_600, close: 83_400 });
    app.runner.enqueue("market-refresh", { singletonKey: "mr-2", maxAttempts: 1 });
    app.runner.enqueue("monitor-tick", { singletonKey: "mt-3", maxAttempts: 1 });
    await h.drain();
    p = getPosition(db, pos.id)!;
    expect(p.status).toBe("closed");
    expect(p.exitReason).toBe("take-profit");
    expect(p.exitPrice).toBe(83_500);
    expect(p.realizedPnl).toBeGreaterThan(0);
    expect(p.realizedR).toBeGreaterThan(2);
    expect(p.fees).toBeCloseTo(83_500 * p.size * 0.0005, 6);
    expect(tg!.texts().some((t) => t.includes("Position closed"))).toBe(true);
    const equity = (await app.executor.account("BTC-USD", scenario.now)).equity;
    expect(equity).toBeCloseTo(10_000 + p.realizedPnl!, 6);

    // --- post-trade review ran from the queue
    expect(
      db.select().from(schema.tradeReviews).where(eq(schema.tradeReviews.positionId, pos.id)).get(),
    ).toBeDefined();
    const lessons = db.select().from(schema.lessons).all();
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.status).toBe("active");
    expect(lessons[0]!.evidence).toContain(pos.id); // the stage prepends the reviewed trade id
    expect(tg!.texts().some((t) => t.includes("Post-trade review"))).toBe(true);

    // --- daily brief
    app.runner.enqueue("daily-brief", { singletonKey: "db-1", maxAttempts: 1 });
    await h.drain();
    const brief = tg!.texts().at(-1)!;
    expect(brief).toMatch(/Daily brief/);
    expect(brief).toMatch(/Summary/);
    expect(brief).toMatch(/PnL/);
    expect(brief).toMatch(/Own count/);
    expect(await app.ports.getBrief()).toBe(brief);

    // --- operator views are consistent with the journal
    const pnl = await app.ports.getPnl("today");
    expect(pnl.trades).toBe(1);
    expect(pnl.wins).toBe(1);
    expect(pnl.netUsd).toBeCloseTo(p.realizedPnl!, 6);
    const why = await app.ports.getWhy(pos.id);
    expect(why?.candidateId).toBe("1h-impulse-a");
    expect(why?.reviewVerdict).toBe("approve");
    expect(why?.events.length).toBeGreaterThan(0);
    const status = await app.ports.getStatus();
    expect(status.openPositions).toBe(0);
    expect(status.lastCycleTerminal).toBeDefined();
    expect(status.llmSpendTodayUsd).toBeGreaterThan(0);

    // --- Telegram sequence
    const order = [
      "Surf daemon started",
      "New MCO Bitcoin video detected",
      "Video ingested",
      "Decision",
      "Order placed",
      "Entry filled",
      "Position closed",
      "Post-trade review",
      "Daily brief",
    ];
    let idx = -1;
    for (const needle of order) {
      const at = tg!.texts().findIndex((t, i) => i > idx && t.includes(needle));
      expect(at, `expected "${needle}" after position ${idx}`).toBeGreaterThan(idx);
      idx = at;
    }
    expect(tg!.sent.every((m) => m.chatId === 42)).toBe(true);
    const jobs = db.select().from(schema.jobs).all();
    expect(jobs.filter((j) => j.status !== "done").map((j) => [j.kind, j.status, j.lastError])).toEqual([]);
    await app.stop();
  });

  it("stays healthy with no LLM and no Telegram, and a video cycle ends blocked", async () => {
    const h = buildHarness({ llm: null, telegram: false });
    await h.app.startup();
    h.app.runner.enqueue("feed-poll", { singletonKey: "fp", maxAttempts: 1 });
    await h.drain();
    h.advance(10 * MIN);
    await h.drain();
    const cycles = h.db.select().from(schema.cycles).all();
    expect(cycles.length).toBe(0); // no prior extracted, so no video cycle
    expect(h.db.select().from(schema.videos).where(eq(schema.videos.videoId, VIDEO_ID)).get()!.status).toBe(
      "blocked",
    );
    h.app.runner.enqueue("hourly-cycle", { singletonKey: "hc", payload: { cycleId: "hc" }, maxAttempts: 1 });
    await h.drain();
    expect(h.db.select().from(schema.cycles).where(eq(schema.cycles.id, "hc")).get()!.terminal).toBe(
      "blocked",
    );
    expect(h.app.health().ok).toBe(true);
    expect(
      h.db
        .select()
        .from(schema.jobs)
        .all()
        .filter((j) => j.status === "dead"),
    ).toEqual([]);
    await h.app.stop();
  });

  it("refuses live mode without Strike credentials", () => {
    expect(() => buildHarness({ llm: null, env: { TRADING_MODE: "live" } })).toThrow(
      /STRIKE_API_PRIVATE_KEY/,
    );
  });

  it("survives a Strike outage: jobs fail, get retried and never kill the process", async () => {
    const h = buildHarness({ llm: null });
    await h.app.startup();
    h.scenario.failStrike = true;
    h.app.runner.enqueue("monitor-tick", { singletonKey: "mt", maxAttempts: 1 });
    h.app.runner.enqueue("hourly-cycle", { singletonKey: "hc", payload: { cycleId: "hc" }, maxAttempts: 2 });
    await h.drain();
    const jobs = h.db.select().from(schema.jobs).all();
    const cycle = jobs.find((j) => j.kind === "hourly-cycle")!;
    expect(cycle.status).toBe("queued"); // retry scheduled
    expect(cycle.lastError).toMatch(/Strike/);
    expect(h.app.ctx.health.lastError?.context).toBe("hourly-cycle");
    expect(h.tg!.texts().some((t) => t.includes("Error") && t.includes("hourly-cycle"))).toBe(true);
    const status = await h.app.ports.getStatus();
    expect(status.feeds.find((f) => f.name === "strike-rest")!.health).not.toBe("ok");
  });
});
