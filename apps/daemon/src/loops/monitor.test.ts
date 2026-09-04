import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLogger } from "@surf/core";
import { schema } from "../db/index.js";
import { getPosition } from "../db/queries.js";
import type { ExchangeView, Executor, PlaceContext } from "../execution/executor.js";
import { buildHarness, H, T0, type Harness } from "../testing/harness.js";
import { monitorTick, RECONCILIATION_HALT } from "./monitor.js";

const log = createLogger("silent");

/** A hand-driven exchange: the test sets what positions/orders/fills the venue reports. */
class FakeExchange implements Executor {
  readonly mode = "shadow" as const;
  view_: ExchangeView = { asOf: 0, positions: [], openOrders: [], fills: [] };
  equity = 10_000;
  calls: string[] = [];
  async placeBracket(_o: never, ctx: PlaceContext) {
    this.calls.push(`place ${ctx.positionId}`);
    return { clientOrderId: "x", strategyId: "s" };
  }
  async cancelResting(p: { id: string }) {
    this.calls.push(`cancel ${p.id}`);
  }
  async flatten(p: { id: string }, reason: string) {
    this.calls.push(`flatten ${p.id} ${reason}`);
  }
  async moveStop(p: { id: string }, s: number) {
    this.calls.push(`moveStop ${p.id} ${s}`);
  }
  async view() {
    return this.view_;
  }
  async account(_s: string, now: number) {
    return {
      asOf: now,
      equity: this.equity,
      availableBalance: this.equity,
      openPositions: this.view_.positions.map((p) => ({ ...p })),
      openOrders: 0,
    };
  }
  async fundingPaid() {
    return 1.5;
  }
}

function seedResting(h: Harness, id = "t1"): void {
  const journal = {
    tradeId: id,
    invalidation: { price: 77_000, label: "w1" },
    candidateId: "1h-impulse-a",
    direction: "long",
    rationale: "r",
    reviewerConfidence: "high",
    setup: "wave-2-end",
    priorVideoId: null,
    evidence: [],
  };
  h.db
    .insert(schema.positions)
    .values({
      id,
      symbol: "BTC-USD",
      direction: "long",
      size: 0.05,
      plannedEntry: 78_900,
      stopLoss: 76_800,
      takeProfit: 83_500,
      initialStop: 76_800,
      leverage: 1,
      riskUsd: 105,
      status: "resting",
      journal,
      createdAt: T0 - H,
      updatedAt: T0 - H,
    })
    .run();
  for (const [role, cid, type] of [
    ["entry", `surf-${id}-entry`, "limit"],
    ["stop", `surf-${id}-sl`, "stop"],
    ["take-profit", `surf-${id}-tp`, "take_profit"],
  ] as const) {
    h.db
      .insert(schema.orders)
      .values({
        clientOrderId: cid,
        positionId: id,
        symbol: "BTC-USD",
        side: role === "entry" ? "buy" : "sell",
        type,
        role,
        size: 0.05,
        status: role === "entry" ? "open" : "untriggered",
        placedAt: T0 - H,
        updatedAt: T0 - H,
      })
      .run();
  }
}

function withFake(h: Harness): FakeExchange {
  const ex = new FakeExchange();
  (h.app.ctx as { executor: Executor }).executor = ex;
  return ex;
}

async function ready(h: Harness) {
  await h.app.ctx.md.backfill();
  await h.app.notifier.flush();
  h.tg!.sent.length = 0;
}

describe("monitor tick", () => {
  it("walks resting -> open -> closed, computes the outcome and enqueues the post-trade review", async () => {
    const h = buildHarness({ llm: null });
    await ready(h);
    const ex = withFake(h);
    seedResting(h);
    ex.view_ = {
      asOf: T0,
      positions: [],
      openOrders: [
        {
          clientOrderId: "surf-t1-entry",
          orderId: "1",
          symbol: "BTC-USD",
          side: "buy",
          type: "limit",
          status: "open",
          size: 0.05,
          filled: 0,
          price: 78_900,
          stopPrice: null,
          reduceOnly: false,
          strategyId: "s",
          createdAt: T0 - H,
        },
      ],
      fills: [],
    };
    let r = await monitorTick(h.app.ctx, log);
    expect(r.filled).toEqual([]);
    expect(getPosition(h.db, "t1")!.status).toBe("resting");

    // fill
    ex.view_ = {
      asOf: T0,
      positions: [
        {
          symbol: "BTC-USD",
          direction: "long",
          size: 0.05,
          entryPrice: 78_900,
          leverage: 1,
          liquidationPrice: null,
          unrealizedPnl: 44,
        },
      ],
      openOrders: [],
      fills: [
        {
          clientOrderId: "surf-t1-entry",
          orderId: "1",
          symbol: "BTC-USD",
          side: "buy",
          price: 78_900,
          size: 0.05,
          fee: 0,
          realizedPnl: 0,
          time: T0 - 10 * 60_000,
          role: "maker",
        },
      ],
    };
    h.advance(60_000);
    r = await monitorTick(h.app.ctx, log);
    expect(r.filled).toEqual(["t1"]);
    let p = getPosition(h.db, "t1")!;
    expect(p.status).toBe("open");
    expect(p.entryPrice).toBe(78_900);
    expect(p.openedAt).toBe(T0 - 10 * 60_000);
    expect(
      h.db.select().from(schema.orders).where(eq(schema.orders.clientOrderId, "surf-t1-entry")).get()!.status,
    ).toBe("filled");
    await h.app.notifier.flush();
    expect(h.tg!.texts().some((t) => t.includes("Entry filled"))).toBe(true);

    // target hit: the position is gone and a TP fill exists
    ex.view_ = {
      asOf: T0,
      positions: [],
      openOrders: [],
      fills: [
        ...ex.view_.fills,
        {
          clientOrderId: "surf-t1-tp",
          orderId: "3",
          symbol: "BTC-USD",
          side: "sell",
          price: 83_500,
          size: 0.05,
          fee: 2.09,
          realizedPnl: 230,
          time: T0 + 3 * H,
          role: "taker",
        },
      ],
    };
    h.advance(3 * H);
    r = await monitorTick(h.app.ctx, log);
    expect(r.closed).toEqual(["t1"]);
    p = getPosition(h.db, "t1")!;
    expect(p.status).toBe("closed");
    expect(p.exitReason).toBe("take-profit");
    expect(p.exitPrice).toBe(83_500);
    expect(p.fees).toBeCloseTo(2.09, 6);
    expect(p.fundingPaid).toBe(1.5);
    expect(p.realizedPnl).toBeCloseTo((83_500 - 78_900) * 0.05 - 2.09 - 1.5, 6);
    expect(p.realizedR).toBeCloseTo(p.realizedPnl! / ((78_900 - 76_800) * 0.05), 6);
    expect(p.closedAt).toBe(T0 + 3 * H);
    const job = h.db.select().from(schema.jobs).where(eq(schema.jobs.singletonKey, "post-trade-t1")).get();
    expect(job?.kind).toBe("post-trade-review");
    await h.app.notifier.flush();
    expect(h.tg!.texts().some((t) => t.includes("Position closed"))).toBe(true);
    expect(h.app.ctx.state.get().consecutiveStopOuts).toBe(0);
  });

  it("flattens on an invalidation breach and moves the stop to breakeven at +1R", async () => {
    const h = buildHarness({ llm: null });
    await ready(h);
    const ex = withFake(h);
    seedResting(h);
    h.db
      .update(schema.positions)
      .set({ status: "open", entryPrice: 78_900, openedAt: T0 - H })
      .where(eq(schema.positions.id, "t1"))
      .run();
    ex.view_ = {
      asOf: T0,
      positions: [
        {
          symbol: "BTC-USD",
          direction: "long",
          size: 0.05,
          entryPrice: 78_900,
          leverage: 1,
          liquidationPrice: null,
          unrealizedPnl: 0,
        },
      ],
      openOrders: [],
      fills: [],
    };
    // +1R: mark >= entry + (entry - initialStop) = 81_000
    h.scenario.mark = 81_050;
    let r = await monitorTick(h.app.ctx, log);
    expect(r.stopsMoved).toEqual(["t1"]);
    expect(ex.calls).toContain("moveStop t1 78900.1");
    expect(getPosition(h.db, "t1")!.stopLoss).toBe(78_900.1);
    // second tick at +1R does not move it again
    r = await monitorTick(h.app.ctx, log);
    expect(r.stopsMoved).toEqual([]);
    // invalidation breach
    h.scenario.mark = 76_990;
    r = await monitorTick(h.app.ctx, log);
    expect(r.flattened).toEqual(["t1"]);
    expect(ex.calls.at(-1)).toBe("flatten t1 invalidation");
    expect(getPosition(h.db, "t1")!.exitReason).toBe("invalidation");
    // once the venue reports the position gone, it closes with the invalidation reason
    ex.view_ = {
      asOf: T0,
      positions: [],
      openOrders: [],
      fills: [
        {
          clientOrderId: "surf-t1-exit",
          orderId: "9",
          symbol: "BTC-USD",
          side: "sell",
          price: 76_985,
          size: 0.05,
          fee: 1.9,
          realizedPnl: -95,
          time: T0 + 60_000,
          role: "taker",
        },
      ],
    };
    r = await monitorTick(h.app.ctx, log);
    const p = getPosition(h.db, "t1")!;
    expect(p.status).toBe("closed");
    expect(p.exitReason).toBe("invalidation");
    expect(p.exitPrice).toBe(76_985);
    expect(h.app.ctx.state.get().consecutiveStopOuts).toBe(1);
  });

  it("halts on an exchange position that is not in the journal", async () => {
    const h = buildHarness({ llm: null });
    await ready(h);
    const ex = withFake(h);
    ex.view_ = {
      asOf: T0,
      positions: [
        {
          symbol: "BTC-USD",
          direction: "short",
          size: 0.1,
          entryPrice: 80_000,
          leverage: 2,
          liquidationPrice: null,
          unrealizedPnl: 0,
        },
      ],
      openOrders: [],
      fills: [],
    };
    const r = await monitorTick(h.app.ctx, log);
    expect(r.mismatch).toBe(true);
    expect(r.halted).toBe(RECONCILIATION_HALT);
    expect(h.app.ctx.state.get().halted).toBe(true);
    await h.app.notifier.flush();
    expect(h.tg!.texts().some((t) => t.includes("TRADING HALTED") && t.includes(RECONCILIATION_HALT))).toBe(
      true,
    );
    // a second tick does not re-notify
    h.tg!.sent.length = 0;
    await monitorTick(h.app.ctx, log);
    await h.app.notifier.flush();
    expect(h.tg!.texts().filter((t) => t.includes("TRADING HALTED"))).toHaveLength(0);
  });

  it("cancels resting entries when an equity halt fires and records heartbeat/equity events", async () => {
    const h = buildHarness({ llm: null });
    await ready(h);
    const ex = withFake(h);
    seedResting(h);
    ex.view_ = {
      asOf: T0,
      positions: [],
      openOrders: [
        {
          clientOrderId: "surf-t1-entry",
          orderId: "1",
          symbol: "BTC-USD",
          side: "buy",
          type: "limit",
          status: "open",
          size: 0.05,
          filled: 0,
          price: 78_900,
          stopPrice: null,
          reduceOnly: false,
          strategyId: "s",
          createdAt: T0 - H,
        },
      ],
      fills: [],
    };
    await monitorTick(h.app.ctx, log); // establishes day-start equity 10,000
    ex.equity = 9_600; // -4% > maxDailyLossPct 3
    const r = await monitorTick(h.app.ctx, log);
    expect(r.halted).toMatch(/daily loss/);
    expect(r.cancelled).toEqual(["t1"]);
    expect(ex.calls).toContain("cancel t1");
    expect(getPosition(h.db, "t1")!.status).toBe("cancelled");
    const kinds = h.db
      .select()
      .from(schema.events)
      .all()
      .map((e) => e.kind);
    expect(kinds.filter((k) => k === "heartbeat")).toHaveLength(2);
    expect(kinds.filter((k) => k === "equity")).toHaveLength(2);
  });
});
