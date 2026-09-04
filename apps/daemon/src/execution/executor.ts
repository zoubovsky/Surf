import type { AccountSnapshot, Candle, Direction, Logger, SizedOrder } from "@surf/core";
import {
  isWithinPriceBound,
  toAccountSnapshot,
  type CreateStrategyOrderRequest,
  type StrikeFill,
  type StrikeOrder,
  type StrikePosition,
  type StrikeRestClient,
} from "@surf/strike";
import type { PositionRow } from "../db/queries.js";

/* ---------- exchange view (what the monitor reconciles against) ---------- */

export interface ExchangePosition {
  symbol: string;
  direction: Direction;
  size: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
}

export interface ExchangeOrder {
  clientOrderId: string;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  status: string;
  size: number;
  filled: number;
  price: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  strategyId: string | null;
  createdAt: number;
}

export interface ExchangeFill {
  clientOrderId: string | null;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Positive = paid, negative = rebate. */
  fee: number;
  realizedPnl: number;
  time: number;
  role: "maker" | "taker" | null;
}

export interface ExchangeView {
  asOf: number;
  positions: ExchangePosition[];
  openOrders: ExchangeOrder[];
  /** Fills since the requested time, oldest first. */
  fills: ExchangeFill[];
}

export interface PlaceContext {
  positionId: string;
  markPrice: number;
  /** Venue bound for limit prices as a fraction of mark (0.05 = 5%). */
  limitTakeBound: number;
  /** True when the account holds no position on the symbol (margin mode can only change while flat). */
  isFlat: boolean;
  now: number;
}

export interface SimulateInput {
  mark: number;
  /** Latest (possibly in-progress) 1h candle on the execution venue, if any. */
  candle: Candle | null;
  fundingRateHourly: number;
  now: number;
}

/**
 * Everything that touches the exchange. Two implementations: `LiveExecutor` (Strike) and
 * `ShadowExecutor` (in-process simulator). The monitor and the decision loop only see this.
 */
export interface Executor {
  readonly mode: "shadow" | "live";
  placeBracket(order: SizedOrder, ctx: PlaceContext): Promise<{ clientOrderId: string; strategyId: string }>;
  cancelResting(position: PositionRow): Promise<void>;
  flatten(position: PositionRow, reason: string): Promise<void>;
  /** Never widens: throws `StopWidenError` when `newStop` is farther from price than the current stop. */
  moveStop(position: PositionRow, newStop: number): Promise<void>;
  view(symbol: string, fillsSince: number): Promise<ExchangeView>;
  account(symbol: string, now: number): Promise<AccountSnapshot>;
  /** Signed funding paid so far for the position (positive = paid). */
  fundingPaid(position: PositionRow): Promise<number>;
  /** Shadow only: advance the simulator with fresh prices. */
  simulate?(input: SimulateInput): void;
}

/* ---------- ids and guards ---------- */

export const clientOrderIds = {
  entry: (positionId: string) => `surf-${positionId}-entry`,
  stop: (positionId: string, n = 0) => (n === 0 ? `surf-${positionId}-sl` : `surf-${positionId}-sl-${n}`),
  takeProfit: (positionId: string) => `surf-${positionId}-tp`,
  exit: (positionId: string) => `surf-${positionId}-exit`,
  strategy: (positionId: string) => `surf-${positionId}`,
};

/** Which leg of a position an order id belongs to, or null when it is not ours. */
export function roleOfClientOrderId(
  id: string | null,
): { positionId: string; role: "entry" | "stop" | "take-profit" | "exit" } | null {
  if (!id) return null;
  const m = /^surf-([A-Za-z0-9]+)-(entry|sl|tp|exit)(?:-\d+)?$/.exec(id);
  if (!m) return null;
  const role = m[2] === "sl" ? "stop" : m[2] === "tp" ? "take-profit" : (m[2] as "entry" | "exit");
  return { positionId: m[1]!, role };
}

export class StopWidenError extends Error {
  override readonly name = "StopWidenError";
}

export class PriceBoundError extends Error {
  override readonly name = "PriceBoundError";
}

export function isWiderStop(direction: Direction, currentStop: number, newStop: number): boolean {
  return direction === "long" ? newStop < currentStop : newStop > currentStop;
}

export function assertNotWider(position: PositionRow, newStop: number): void {
  if (isWiderStop(position.direction as Direction, position.stopLoss, newStop)) {
    throw new StopWidenError(
      `refusing to widen stop on ${position.id}: ${position.stopLoss} -> ${newStop} (${position.direction})`,
    );
  }
}

export const TAKER_FEE_RATE = 0.0005;

/* ---------- live ---------- */

export interface LiveExecutorOptions {
  rest: StrikeRestClient;
  log: Logger;
  now: () => number;
}

export function mapStrikePosition(p: StrikePosition): ExchangePosition {
  return {
    symbol: p.symbol,
    direction: p.size >= 0 ? "long" : "short",
    size: Math.abs(p.size),
    entryPrice: p.entryPrice,
    leverage: p.leverage > 0 ? p.leverage : 1,
    liquidationPrice: p.liquidationPrice,
    unrealizedPnl: p.unrealizedPnl,
  };
}

export function mapStrikeOrder(o: StrikeOrder): ExchangeOrder {
  return {
    clientOrderId: o.clientOrderId,
    orderId: String(o.id),
    symbol: o.symbol,
    side: o.side === "sell" ? "sell" : "buy",
    type: o.type,
    status: o.status,
    size: o.size,
    filled: o.filled,
    price: o.price > 0 ? o.price : null,
    stopPrice: o.stopPrice > 0 ? o.stopPrice : null,
    reduceOnly: o.reduceOnly,
    strategyId: o.strategy?.id ?? null,
    createdAt: o.createTimestamp,
  };
}

export function mapStrikeFill(f: StrikeFill, clientOrderId: string | null): ExchangeFill {
  return {
    clientOrderId,
    orderId: String(f.orderId),
    symbol: f.symbol,
    side: f.side,
    price: f.price,
    size: f.size,
    fee: f.fee,
    realizedPnl: f.realizedPnl,
    time: f.timestamp,
    role: f.role,
  };
}

/**
 * Places Strike bracket orders and manages them. Strike's fill history carries order ids, not
 * client ids, so the executor remembers `orderId -> clientOrderId` from open orders and from the
 * user stream (`rememberOrderId`) to attribute fills to our legs.
 */
export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly rest: StrikeRestClient;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly orderIds = new Map<string, string>(); // exchange order id -> client order id
  /** Test hook: the exact strategy requests sent. */
  readonly sentStrategies: CreateStrategyOrderRequest[] = [];

  constructor(opts: LiveExecutorOptions) {
    this.rest = opts.rest;
    this.log = opts.log.child({ component: "executor", mode: "live" });
    this.now = opts.now;
  }

  rememberOrderId(orderId: string | number, clientOrderId: string): void {
    if (clientOrderId) this.orderIds.set(String(orderId), clientOrderId);
  }

  async placeBracket(
    order: SizedOrder,
    ctx: PlaceContext,
  ): Promise<{ clientOrderId: string; strategyId: string }> {
    if (
      order.entryKind === "limit" &&
      !isWithinPriceBound(order.entryPrice, ctx.markPrice, ctx.limitTakeBound)
    ) {
      throw new PriceBoundError(
        `limit ${order.entryPrice} is outside the venue bound (${ctx.limitTakeBound * 100}% of mark ${ctx.markPrice})`,
      );
    }
    if (ctx.isFlat) await this.rest.setMarginMode(order.symbol, "isolated");
    await this.rest.setLeverage(order.symbol, Math.max(1, Math.ceil(order.leverage)));
    const side = order.direction === "long" ? "buy" : "sell";
    const req: CreateStrategyOrderRequest = {
      strategy_id: clientOrderIds.strategy(ctx.positionId),
      symbol: order.symbol,
      side,
      type: order.entryKind,
      size: order.size,
      client_order_id: clientOrderIds.entry(ctx.positionId),
      ...(order.entryKind === "limit"
        ? { price: order.entryPrice, time_in_force: "GTC" as const, post_only: true }
        : {}),
      tp_order: {
        type: "take_profit",
        size: order.size,
        stop_price: order.takeProfit,
        working_type: "mark_price",
        client_order_id: clientOrderIds.takeProfit(ctx.positionId),
      },
      sl_order: {
        type: "stop",
        size: order.size,
        stop_price: order.stopLoss,
        working_type: "mark_price",
        client_order_id: clientOrderIds.stop(ctx.positionId),
      },
    };
    this.sentStrategies.push(req);
    const ack = await this.rest.createStrategyOrder(req);
    this.log.info({ positionId: ctx.positionId, strategyId: ack.strategyId }, "bracket placed");
    return {
      clientOrderId: clientOrderIds.entry(ctx.positionId),
      strategyId: ack.strategyId || req.strategy_id,
    };
  }

  async cancelResting(position: PositionRow): Promise<void> {
    const open = await this.rest.openOrders(position.symbol);
    const ours = open.filter((o) => roleOfClientOrderId(o.clientOrderId)?.positionId === position.id);
    for (const o of ours) {
      await this.rest.cancelOrder({ order_id: o.id, symbol: position.symbol });
    }
    if (ours.length === 0)
      this.log.warn({ positionId: position.id }, "cancelResting: no orders found on venue");
  }

  async flatten(position: PositionRow, reason: string): Promise<void> {
    const side = position.direction === "long" ? "sell" : "buy";
    await this.rest.createOrder({
      symbol: position.symbol,
      side,
      type: "market",
      size: position.size,
      reduce_only: true,
      client_order_id: clientOrderIds.exit(position.id),
    });
    await this.rest.cancelAll(position.symbol);
    this.log.warn({ positionId: position.id, reason }, "position flattened");
  }

  async moveStop(position: PositionRow, newStop: number): Promise<void> {
    assertNotWider(position, newStop);
    const side: "buy" | "sell" = position.direction === "long" ? "sell" : "buy";
    const open = await this.rest.openOrders(position.symbol);
    const current = open.find(
      (o) =>
        roleOfClientOrderId(o.clientOrderId)?.positionId === position.id &&
        roleOfClientOrderId(o.clientOrderId)?.role === "stop",
    );
    const n = (Math.floor(this.now() / 1000) % 1_000_000) + 1;
    const newOrder = {
      symbol: position.symbol,
      side,
      type: "stop" as const,
      size: position.size,
      stop_price: newStop,
      working_type: "mark_price" as const,
      reduce_only: true,
      client_order_id: clientOrderIds.stop(position.id, n),
    };
    if (current) {
      await this.rest.replaceOrder({
        cancel: { order_id: current.id, symbol: position.symbol },
        new_order: newOrder,
      });
    } else {
      this.log.warn(
        { positionId: position.id },
        "moveStop: stop leg not found on venue; creating close-position stop",
      );
      await this.rest.createOrder({ ...newOrder, close_position: true });
    }
  }

  async view(symbol: string, fillsSince: number): Promise<ExchangeView> {
    const [positions, openOrders] = await Promise.all([
      this.rest.positions(symbol),
      this.rest.openOrders(symbol),
    ]);
    for (const o of openOrders) this.rememberOrderId(o.id, o.clientOrderId);
    let fills: StrikeFill[] = [];
    try {
      fills = await this.rest.fillHistory({ symbol, startTime: fillsSince, limit: 200 });
    } catch (err) {
      this.log.warn({ err: String(err) }, "fill history unavailable");
    }
    return {
      asOf: this.now(),
      positions: positions.map(mapStrikePosition),
      openOrders: openOrders.map(mapStrikeOrder),
      fills: fills
        .map((f) => mapStrikeFill(f, this.orderIds.get(String(f.orderId)) ?? null))
        .sort((a, b) => a.time - b.time),
    };
  }

  async account(symbol: string, now: number): Promise<AccountSnapshot> {
    const [acct, positions, openOrders] = await Promise.all([
      this.rest.account(),
      this.rest.positions(symbol),
      this.rest.openOrders(symbol),
    ]);
    return toAccountSnapshot(acct, positions, { openOrders, asOf: now });
  }

  async fundingPaid(position: PositionRow): Promise<number> {
    if (position.openedAt === null) return 0;
    try {
      const rows = await this.rest.fundingHistory({
        symbol: position.symbol,
        startTime: position.openedAt,
        limit: 500,
      });
      // Strike reports positive = received; we store positive = paid.
      return -rows.reduce((s, r) => s + r.amount, 0);
    } catch (err) {
      this.log.warn({ err: String(err) }, "funding history unavailable");
      return position.fundingPaid;
    }
  }
}
