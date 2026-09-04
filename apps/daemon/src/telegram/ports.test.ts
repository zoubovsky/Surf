import { describe, expect, it } from "vitest";
import { schema } from "../db/index.js";
import { insertEvent } from "../db/queries.js";
import { buildHarness, H, T0 } from "../testing/harness.js";
import { maxDrawdownPct, pnlReport, rangeStart } from "./ports.js";

const DAY = 86_400_000;

function closed(id: string, closedAt: number, over: Partial<typeof schema.positions.$inferInsert> = {}) {
  return {
    id,
    symbol: "BTC-USD",
    direction: "long",
    size: 0.05,
    entryPrice: 78_900,
    plannedEntry: 78_900,
    stopLoss: 76_800,
    takeProfit: 83_500,
    initialStop: 76_800,
    leverage: 1,
    riskUsd: 105,
    status: "closed",
    openedAt: closedAt - 3 * H,
    closedAt,
    exitPrice: 83_500,
    exitReason: "take-profit",
    realizedPnl: 226, // net of fees and funding
    realizedR: 2.15,
    fees: 2,
    fundingPaid: 2,
    journal: { tradeId: id, setup: "wave-2-end", reviewerConfidence: "high", priorVideoId: null },
    createdAt: closedAt - 4 * H,
    updatedAt: closedAt,
    ...over,
  };
}

describe("ports.getPnl", () => {
  it("aggregates closed trades per range and reads drawdown from the equity series", async () => {
    const h = buildHarness({ llm: null });
    const now = T0;
    h.db
      .insert(schema.positions)
      .values([
        closed("a", now - 2 * H),
        closed("b", now - 3 * DAY, {
          realizedPnl: -100,
          realizedR: -1,
          exitReason: "stop",
          fees: 3,
          fundingPaid: 1,
        }),
        closed("c", now - 20 * DAY, {
          realizedPnl: 50,
          realizedR: 0.5,
          journal: { tradeId: "c", setup: "wave-4-end", reviewerConfidence: "medium", priorVideoId: "v" },
        }),
        closed("d", now - 60 * DAY),
      ])
      .run();
    for (const [at, equity] of [
      [now - 25 * DAY, 10_000],
      [now - 20 * DAY, 10_050],
      [now - 3 * DAY, 9_950],
      [now - 2 * H, 10_176],
    ] as const) {
      insertEvent(h.db, "info", "equity", { equity }, at);
    }
    const today = pnlReport(h.app.ctx, "today", 10_176, 0);
    expect(today.trades).toBe(1);
    expect(today.wins).toBe(1);
    expect(today.realizedUsd).toBeCloseTo(230, 6); // gross
    expect(today.feesUsd).toBe(2);
    expect(today.fundingUsd).toBe(-2);
    expect(today.netUsd).toBeCloseTo(226, 6);
    expect(today.rows.map((r) => r.tradeId)).toEqual(["a"]);
    expect(today.from).toBe(Date.UTC(2026, 8, 4)); // UTC midnight in the harness zone

    const d7 = pnlReport(h.app.ctx, "7d", 10_176, 0);
    expect(d7.trades).toBe(2);
    expect(d7.losses).toBe(1);
    expect(d7.netUsd).toBeCloseTo(126, 6);
    expect(d7.avgR).toBeCloseTo((2.15 - 1) / 2, 6);
    expect(d7.bestR).toBe(2.15);
    expect(d7.worstR).toBe(-1);
    expect(d7.startEquity).toBe(9_950);
    expect(d7.endEquity).toBe(10_176);
    expect(d7.maxDrawdownPct).toBe(0);

    const d30 = pnlReport(h.app.ctx, "30d", 10_176, 0);
    expect(d30.trades).toBe(3);
    expect(d30.rows.map((r) => r.setup)).toEqual(["wave-2-end", "wave-2-end", "wave-4-end"]);
    expect(d30.startEquity).toBe(10_000);
    expect(d30.maxDrawdownPct).toBeCloseTo(((10_050 - 9_950) / 10_050) * 100, 6);
    expect(d30.netPct).toBeCloseTo((d30.netUsd / 10_000) * 100, 6);

    expect(pnlReport(h.app.ctx, "all", 10_176, 0).trades).toBe(4);
  });

  it("includes unrealized PnL in net and works without a live equity reading", () => {
    const h = buildHarness({ llm: null });
    h.db
      .insert(schema.positions)
      .values([closed("a", T0 - H)])
      .run();
    const r = pnlReport(h.app.ctx, "today", null, 40);
    expect(r.unrealizedUsd).toBe(40);
    expect(r.netUsd).toBeCloseTo(266, 6);
    expect(r.endEquity).toBe(0);
  });

  it("helpers: range start and drawdown", () => {
    expect(rangeStart("today", Date.UTC(2026, 8, 4, 13, 20), "UTC")).toBe(Date.UTC(2026, 8, 4));
    expect(rangeStart("today", Date.UTC(2026, 8, 4, 0, 30), "Europe/London")).toBe(Date.UTC(2026, 8, 3, 23));
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(25, 6);
    expect(maxDrawdownPct([])).toBe(0);
  });

  it("getStatus reports mode, feeds and version; getWhy returns null for unknown ids", async () => {
    const h = buildHarness({ llm: null });
    await h.app.startup();
    const s = await h.app.ports.getStatus();
    expect(s.mode).toBe("shadow");
    expect(s.version).toBe("test");
    expect(s.feeds.map((f) => f.name)).toEqual([
      "strike-rest",
      "strike-ws",
      "market-data",
      "youtube-feed",
      "transcripts",
      "llm",
    ]);
    expect(s.feeds.find((f) => f.name === "strike-rest")!.health).toBe("ok");
    expect(s.feeds.find((f) => f.name === "llm")!.detail).toBe("no ANTHROPIC_API_KEY");
    expect(await h.app.ports.getWhy("nope")).toBeNull();
    expect(await h.app.ports.answerQuestion("hi")).toMatch(/unavailable/);
    expect(await h.app.ports.getBrief()).toMatch(/No brief yet/);
    const msg = await h.app.ports.pause({ flatten: false });
    expect(msg).toMatch(/Paused/);
    expect(h.app.ctx.state.get().paused).toBe(true);
    expect(await h.app.ports.resume()).toMatch(/Resumed/);
    expect(h.app.ctx.state.get().paused).toBe(false);
  });
});
