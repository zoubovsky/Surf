import { describe, expect, it } from "vitest";
import { createLogger, type Candle, type SizedOrder } from "@surf/core";
import { openDb } from "../db/index.js";
import type { PositionRow } from "../db/queries.js";
import { StopWidenError } from "./executor.js";
import { ShadowExecutor } from "./shadow.js";

const NOW = 1_788_540_000_000;
const H = 3_600_000;

function setup() {
  const { db } = openDb({ path: ":memory:" });
  const clock = { t: NOW };
  const exec = new ShadowExecutor({ db, log: createLogger("silent"), now: () => clock.t, symbol: "BTC-USD" });
  return { db, exec, clock };
}

const order: SizedOrder = {
  symbol: "BTC-USD",
  direction: "long",
  entryKind: "limit",
  entryPrice: 78_000,
  size: 0.05,
  notionalUsd: 3900,
  leverage: 1,
  marginUsd: 3900,
  stopLoss: 76_000,
  takeProfit: 82_000,
  riskUsd: 100,
  rewardRisk: 2,
  expectedFundingUsd: 0,
};

const candle = (low: number, high: number, openTime = NOW): Candle => ({
  venue: "strike",
  symbol: "BTC-USD",
  interval: "1h",
  openTime,
  closeTime: openTime + H - 1,
  open: (low + high) / 2,
  high,
  low,
  close: (low + high) / 2,
  volume: 1,
});

const ctx = (positionId: string, mark = 79_500) => ({
  positionId,
  markPrice: mark,
  limitTakeBound: 0.05,
  isFlat: true,
  now: NOW,
});

function row(id: string, over: Partial<PositionRow> = {}): PositionRow {
  return {
    id,
    cycleId: null,
    proposalId: null,
    symbol: "BTC-USD",
    direction: "long",
    size: 0.05,
    entryPrice: 78_000,
    plannedEntry: 78_000,
    stopLoss: 76_000,
    takeProfit: 82_000,
    initialStop: 76_000,
    leverage: 1,
    riskUsd: 100,
    status: "open",
    openedAt: NOW,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    realizedR: null,
    fees: 0,
    fundingPaid: 0,
    mae: null,
    mfe: null,
    journal: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("ShadowExecutor", () => {
  it("rests a limit bracket, fills it when the candle low touches, and reports the position", async () => {
    const { exec } = setup();
    await exec.placeBracket(order, ctx("p1"));
    let v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(0);
    expect(v.openOrders.map((o) => [o.clientOrderId, o.status])).toEqual([
      ["surf-p1-entry", "open"],
      ["surf-p1-sl", "untriggered"],
      ["surf-p1-tp", "untriggered"],
    ]);
    exec.simulate({ mark: 79_000, candle: candle(78_500, 79_600), fundingRateHourly: 0, now: NOW + 60_000 });
    expect((await exec.view("BTC-USD", 0)).positions).toHaveLength(0);
    exec.simulate({ mark: 78_300, candle: candle(77_900, 79_600), fundingRateHourly: 0, now: NOW + 120_000 });
    v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(1);
    expect(v.positions[0]).toMatchObject({ direction: "long", size: 0.05, entryPrice: 78_000 });
    expect(v.fills).toHaveLength(1);
    expect(v.fills[0]).toMatchObject({
      clientOrderId: "surf-p1-entry",
      price: 78_000,
      fee: 0,
      role: "maker",
    });
    expect(v.openOrders.map((o) => [o.clientOrderId, o.status])).toEqual([
      ["surf-p1-sl", "open"],
      ["surf-p1-tp", "open"],
    ]);
    const a = await exec.account("BTC-USD", NOW + 120_000);
    expect(a.openPositions).toHaveLength(1);
    expect(a.equity).toBeCloseTo(10_000 + (78_300 - 78_000) * 0.05, 6);
  });

  it("fills the take-profit only from a bar after the fill, and pays the taker fee", async () => {
    const { exec } = setup();
    await exec.placeBracket(order, ctx("p2"));
    // same bar has a high above TP before the fill: must not count
    exec.simulate({
      mark: 78_500,
      candle: candle(77_900, 83_000, NOW - 1000),
      fundingRateHourly: 0,
      now: NOW,
    });
    let v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(1);
    exec.simulate({
      mark: 81_000,
      candle: candle(80_000, 82_500, NOW + H),
      fundingRateHourly: 0,
      now: NOW + H + 60_000,
    });
    v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(0);
    const exit = v.fills.find((f) => f.clientOrderId === "surf-p2-tp")!;
    expect(exit.price).toBe(82_000);
    expect(exit.fee).toBeCloseTo(82_000 * 0.05 * 0.0005, 6);
    expect(exec.equity).toBeCloseTo(10_000 + (82_000 - 78_000) * 0.05 - exit.fee, 6);
  });

  it("checks the stop before the take-profit on the same bar (conservative)", async () => {
    const { exec } = setup();
    await exec.placeBracket(order, ctx("p3"));
    exec.simulate({ mark: 78_000, candle: candle(77_950, 78_050), fundingRateHourly: 0, now: NOW });
    expect((await exec.view("BTC-USD", 0)).positions).toHaveLength(1);
    // one wild bar after the fill spans both the stop and the target
    exec.simulate({
      mark: 79_000,
      candle: candle(75_000, 83_000, NOW + H),
      fundingRateHourly: 0,
      now: NOW + H + 1,
    });
    const v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(0);
    expect(v.fills.at(-1)).toMatchObject({ clientOrderId: "surf-p3-sl", price: 76_000 });
    expect(exec.equity).toBeLessThan(10_000);
  });

  it("stops out on mark alone and accrues hourly funding while open", async () => {
    const { exec } = setup();
    await exec.placeBracket({ ...order, entryKind: "market" }, ctx("p4", 78_000));
    let v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(1);
    expect(v.fills[0]!.role).toBe("taker");
    exec.simulate({ mark: 78_100, candle: null, fundingRateHourly: 0.0001, now: NOW + 2 * H });
    expect(await exec.fundingPaid(row("p4"))).toBeCloseTo(2 * 0.0001 * 0.05 * 78_100, 8);
    exec.simulate({ mark: 75_900, candle: null, fundingRateHourly: 0.0001, now: NOW + 2 * H + 1 });
    v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(0);
    expect(v.fills.at(-1)!.clientOrderId).toBe("surf-p4-sl");
    expect(await exec.fundingPaid(row("p4"))).toBeGreaterThan(0);
  });

  it("fills a short when the candle high reaches the limit and stops it when mark rises", async () => {
    const { exec } = setup();
    const short: SizedOrder = {
      ...order,
      direction: "short",
      entryPrice: 80_000,
      stopLoss: 81_500,
      takeProfit: 76_000,
    };
    await exec.placeBracket(short, ctx("p5", 79_000));
    exec.simulate({ mark: 79_500, candle: candle(79_000, 80_100), fundingRateHourly: 0, now: NOW });
    expect((await exec.view("BTC-USD", 0)).positions[0]).toMatchObject({
      direction: "short",
      entryPrice: 80_000,
    });
    exec.simulate({ mark: 81_600, candle: null, fundingRateHourly: 0, now: NOW + 1 });
    expect((await exec.view("BTC-USD", 0)).positions).toHaveLength(0);
  });

  it("moveStop tightens but never widens; flatten exits at mark; cancelResting removes the bracket", async () => {
    const { exec } = setup();
    await exec.placeBracket(order, ctx("p6"));
    await exec.cancelResting(row("p6", { status: "resting" }));
    expect((await exec.view("BTC-USD", 0)).openOrders).toHaveLength(0);

    await exec.placeBracket({ ...order, entryKind: "market" }, ctx("p7", 78_000));
    await expect(exec.moveStop(row("p7"), 75_000)).rejects.toBeInstanceOf(StopWidenError);
    await exec.moveStop(row("p7"), 78_000.1);
    const sl = (await exec.view("BTC-USD", 0)).openOrders.find((o) => o.clientOrderId === "surf-p7-sl")!;
    expect(sl.stopPrice).toBe(78_000.1);
    exec.simulate({ mark: 79_000, candle: null, fundingRateHourly: 0, now: NOW + 1 });
    await exec.flatten(row("p7"), "test");
    const v = await exec.view("BTC-USD", 0);
    expect(v.positions).toHaveLength(0);
    expect(v.openOrders).toHaveLength(0);
    expect(v.fills.at(-1)).toMatchObject({ clientOrderId: "surf-p7-exit", price: 79_000 });
  });

  it("persists its state in kv so a new instance sees the same orders and equity", async () => {
    const { db, exec, clock } = setup();
    await exec.placeBracket(order, ctx("p8"));
    const again = new ShadowExecutor({
      db,
      log: createLogger("silent"),
      now: () => clock.t,
      symbol: "BTC-USD",
    });
    expect((await again.view("BTC-USD", 0)).openOrders).toHaveLength(3);
    again.simulate({ mark: 77_000, candle: null, fundingRateHourly: 0, now: NOW });
    expect((await again.view("BTC-USD", 0)).positions[0]!.leverage).toBe(1);
    expect(again.equity).toBe(10_000);
  });
});
