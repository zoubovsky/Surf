import { describe, expect, it } from "vitest";
import { createLogger, type SizedOrder } from "@surf/core";
import { StrikeRestClient } from "@surf/strike";
import {
  createStrategyAckFixture,
  createOrderAckFixture,
  openOrdersFixture,
} from "../../../../packages/strike/src/fixtures/index.js";
import type { PositionRow } from "../db/queries.js";
import { LiveExecutor, PriceBoundError, StopWidenError, roleOfClientOrderId } from "./executor.js";

const SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const NOW = 1_788_540_000_000;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function harness(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: path, method: init.method ?? "GET", body });
    const canned =
      responses[path] ??
      (path === "/v2/marginMode"
        ? { symbol: "BTC-USD", marginMode: "isolated" }
        : path === "/v2/leverage"
          ? { symbol: "BTC-USD", leverage: (body as { leverage: number }).leverage, maxNotionalValue: null }
          : { ok: true });
    return new Response(JSON.stringify(canned), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rest = new StrikeRestClient({
    baseUrl: "https://example.test",
    credentials: { privateKey: SK },
    fetch: fetchImpl,
    clock: { now: () => NOW },
    retry: { attempts: 1 },
  });
  const exec = new LiveExecutor({ rest, log: createLogger("silent"), now: () => NOW });
  return { exec, calls };
}

const longLimit: SizedOrder = {
  symbol: "BTC-USD",
  direction: "long",
  entryKind: "limit",
  entryPrice: 78_100,
  size: 0.0476,
  notionalUsd: 3717.56,
  leverage: 1,
  marginUsd: 3717.56,
  stopLoss: 75_600,
  takeProfit: 82_400,
  riskUsd: 119,
  rewardRisk: 1.7,
  expectedFundingUsd: 0.5,
};

const shortMarket: SizedOrder = {
  ...longLimit,
  direction: "short",
  entryKind: "market",
  entryPrice: 79_780,
  leverage: 2.3,
  stopLoss: 81_500,
  takeProfit: 76_000,
};

function position(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: "abc123",
    cycleId: null,
    proposalId: null,
    symbol: "BTC-USD",
    direction: "long",
    size: 0.0476,
    entryPrice: 78_100,
    plannedEntry: 78_100,
    stopLoss: 75_600,
    takeProfit: 82_400,
    initialStop: 75_600,
    leverage: 1,
    riskUsd: 119,
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

describe("LiveExecutor.placeBracket", () => {
  it("sends margin mode, leverage and an exact long limit bracket", async () => {
    const { exec, calls } = harness({ "/v2/order/strategy": createStrategyAckFixture });
    const r = await exec.placeBracket(longLimit, {
      positionId: "abc123",
      markPrice: 79_780,
      limitTakeBound: 0.05,
      isFlat: true,
      now: NOW,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v2/marginMode",
      "POST /v2/leverage",
      "POST /v2/order/strategy",
    ]);
    expect(calls[0]!.body).toEqual({ symbol: "BTC-USD", marginMode: "isolated" });
    expect(calls[1]!.body).toEqual({ symbol: "BTC-USD", leverage: 1 });
    expect(calls[2]!.body).toEqual({
      strategy_id: "surf-abc123",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      size: "0.04760",
      price: "78100.0",
      time_in_force: "GTC",
      post_only: true,
      client_order_id: "surf-abc123-entry",
      tp_order: {
        type: "take_profit",
        size: "0.04760",
        stop_price: "82400.0",
        working_type: "mark_price",
        client_order_id: "surf-abc123-tp",
      },
      sl_order: {
        type: "stop",
        size: "0.04760",
        stop_price: "75600.0",
        working_type: "mark_price",
        client_order_id: "surf-abc123-sl",
      },
    });
    expect(r).toEqual({ clientOrderId: "surf-abc123-entry", strategyId: "s-001" });
  });

  it("sends a short market bracket without price/post-only and skips margin mode when not flat", async () => {
    const { exec, calls } = harness({ "/v2/order/strategy": createStrategyAckFixture });
    await exec.placeBracket(shortMarket, {
      positionId: "def456",
      markPrice: 79_780,
      limitTakeBound: 0.05,
      isFlat: false,
      now: NOW,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v2/leverage",
      "POST /v2/order/strategy",
    ]);
    expect(calls[0]!.body).toEqual({ symbol: "BTC-USD", leverage: 3 }); // ceil(2.3)
    expect(calls[1]!.body).toEqual({
      strategy_id: "surf-def456",
      symbol: "BTC-USD",
      side: "sell",
      type: "market",
      size: "0.04760",
      client_order_id: "surf-def456-entry",
      tp_order: {
        type: "take_profit",
        size: "0.04760",
        stop_price: "76000.0",
        working_type: "mark_price",
        client_order_id: "surf-def456-tp",
      },
      sl_order: {
        type: "stop",
        size: "0.04760",
        stop_price: "81500.0",
        working_type: "mark_price",
        client_order_id: "surf-def456-sl",
      },
    });
  });

  it("refuses a limit outside the venue price bound before touching the venue", async () => {
    const { exec, calls } = harness();
    await expect(
      exec.placeBracket(
        { ...longLimit, entryPrice: 70_000 },
        { positionId: "x", markPrice: 79_780, limitTakeBound: 0.05, isFlat: true, now: NOW },
      ),
    ).rejects.toBeInstanceOf(PriceBoundError);
    expect(calls).toHaveLength(0);
  });
});

describe("LiveExecutor stop and exit management", () => {
  it("never widens a stop", async () => {
    const { exec, calls } = harness();
    await expect(
      exec.moveStop(position({ direction: "long", stopLoss: 75_600 }), 75_000),
    ).rejects.toBeInstanceOf(StopWidenError);
    await expect(
      exec.moveStop(position({ direction: "short", stopLoss: 81_500 }), 82_000),
    ).rejects.toBeInstanceOf(StopWidenError);
    expect(calls).toHaveLength(0);
  });

  it("replaces the existing stop leg atomically when tightening", async () => {
    const orders = {
      orders: [{ ...openOrdersFixture.orders[1]!, ClientOrderID: "surf-abc123-sl", ID: 555 }],
      count: 1,
    };
    const { exec, calls } = harness({
      "/v2/openOrders": orders,
      "/v2/order/replace": { cancel: {}, new_order: createOrderAckFixture },
    });
    await exec.moveStop(position(), 78_100.1);
    const replace = calls.find((c) => c.url === "/v2/order/replace")!;
    expect(replace.body).toMatchObject({
      cancel: { order_id: 555, symbol: "BTC-USD" },
      new_order: {
        symbol: "BTC-USD",
        side: "sell",
        type: "stop",
        size: "0.04760",
        stop_price: "78100.1",
        working_type: "mark_price",
        reduce_only: true,
      },
    });
    expect((replace.body as { new_order: { client_order_id: string } }).new_order.client_order_id).toMatch(
      /^surf-abc123-sl-\d+$/,
    );
  });

  it("creates a close-position stop when the leg is not on the venue", async () => {
    const { exec, calls } = harness({
      "/v2/openOrders": { orders: [], count: 0 },
      "/v2/order": createOrderAckFixture,
    });
    await exec.moveStop(position(), 78_100.1);
    const create = calls.find((c) => c.url === "/v2/order")!;
    expect(create.body).toMatchObject({
      type: "stop",
      stop_price: "78100.1",
      close_position: true,
      reduce_only: true,
    });
  });

  it("flattens with an opposite-side reduce-only market order then cancels all", async () => {
    const { exec, calls } = harness({
      "/v2/order": createOrderAckFixture,
      "/v2/order/cancel-all": { canceledCount: 3 },
    });
    await exec.flatten(position({ direction: "long" }), "invalidation");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v2/order",
      "DELETE /v2/order/cancel-all",
    ]);
    expect(calls[0]!.body).toEqual({
      symbol: "BTC-USD",
      side: "sell",
      type: "market",
      size: "0.04760",
      reduce_only: true,
      client_order_id: "surf-abc123-exit",
    });
    expect(calls[1]!.body).toEqual({ symbol: "BTC-USD" });
  });

  it("cancels only our resting orders", async () => {
    const orders = {
      orders: [
        { ...openOrdersFixture.orders[0]!, ClientOrderID: "surf-abc123-entry", ID: 1 },
        { ...openOrdersFixture.orders[1]!, ClientOrderID: "surf-abc123-sl", ID: 2 },
        { ...openOrdersFixture.orders[0]!, ClientOrderID: "someone-else", ID: 3 },
      ],
      count: 3,
    };
    const { exec, calls } = harness({
      "/v2/openOrders": orders,
      "/v2/order/cancel": { order_id: 1, status: "canceled" },
    });
    await exec.cancelResting(position({ status: "resting" }));
    const cancels = calls
      .filter((c) => c.url === "/v2/order/cancel")
      .map((c) => (c.body as { order_id: number }).order_id);
    expect(cancels).toEqual([1, 2]);
  });
});

describe("roleOfClientOrderId", () => {
  it("parses our ids and rejects foreign ones", () => {
    expect(roleOfClientOrderId("surf-abc123-entry")).toEqual({ positionId: "abc123", role: "entry" });
    expect(roleOfClientOrderId("surf-abc123-sl-42")).toEqual({ positionId: "abc123", role: "stop" });
    expect(roleOfClientOrderId("surf-abc123-tp")).toEqual({ positionId: "abc123", role: "take-profit" });
    expect(roleOfClientOrderId("surf-abc123-exit")).toEqual({ positionId: "abc123", role: "exit" });
    expect(roleOfClientOrderId("entry-001")).toBeNull();
    expect(roleOfClientOrderId(null)).toBeNull();
  });
});
