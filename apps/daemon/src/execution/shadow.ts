import type { AccountSnapshot, Direction, Logger, SizedOrder } from "@surf/core";
import { kvGet, kvSet, type Db } from "../db/index.js";
import { KV, type PositionRow } from "../db/queries.js";
import {
  assertNotWider,
  clientOrderIds,
  TAKER_FEE_RATE,
  type ExchangeFill,
  type ExchangeOrder,
  type ExchangePosition,
  type ExchangeView,
  type Executor,
  type PlaceContext,
  type SimulateInput,
} from "./executor.js";

export const DEFAULT_SHADOW_EQUITY = 10_000;
const HOUR = 3_600_000;

export interface SimOrder {
  clientOrderId: string;
  positionId: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market" | "stop" | "take_profit";
  size: number;
  price: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  strategyId: string;
  createdAt: number;
  /** `open` = working; `untriggered` = bracket leg waiting for the entry fill. */
  status: "open" | "untriggered";
  /** Entry orders only: leverage the position opens with. */
  leverage?: number;
}

export interface SimPosition {
  positionId: string;
  symbol: string;
  direction: Direction;
  size: number;
  entryPrice: number;
  leverage: number;
  openedAt: number;
  lastFundingAt: number;
  fundingPaid: number;
}

export interface SimClosed {
  positionId: string;
  fundingPaid: number;
  fees: number;
  exitPrice: number;
  closedAt: number;
}

export interface SimState {
  orders: SimOrder[];
  positions: SimPosition[];
  fills: ExchangeFill[];
  closed: SimClosed[];
  lastMark: number | null;
}

const EMPTY: SimState = { orders: [], positions: [], fills: [], closed: [], lastMark: null };

export interface ShadowExecutorOptions {
  db: Db;
  log: Logger;
  now: () => number;
  symbol: string;
  initialEquity?: number;
}

/**
 * In-process exchange simulator persisted in the kv table so shadow positions survive restarts.
 * Fill rules (conservative):
 *  - a resting long fills when the latest 1h candle's low <= price (short: high >= price) or mark crosses it;
 *    the fill price is the limit price (maker, fee 0);
 *  - stop and take-profit trigger on mark or the candle range; on the same bar the stop is checked first;
 *    the take-profit only uses candles that opened after the fill (never pre-fill highs);
 *  - exits pay the taker fee (0.05%); funding accrues at every hour boundary as rate x notional, longs pay when positive.
 */
export class ShadowExecutor implements Executor {
  readonly mode = "shadow" as const;
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly symbol: string;
  private state: SimState;

  constructor(opts: ShadowExecutorOptions) {
    this.db = opts.db;
    this.log = opts.log.child({ component: "executor", mode: "shadow" });
    this.now = opts.now;
    this.symbol = opts.symbol;
    this.state = kvGet<SimState>(this.db, KV.shadowExchange) ?? structuredClone(EMPTY);
    if (kvGet<number>(this.db, KV.shadowEquity) === null) {
      kvSet(this.db, KV.shadowEquity, opts.initialEquity ?? DEFAULT_SHADOW_EQUITY, this.now());
    }
  }

  get equity(): number {
    return kvGet<number>(this.db, KV.shadowEquity) ?? DEFAULT_SHADOW_EQUITY;
  }

  private setEquity(v: number): void {
    kvSet(this.db, KV.shadowEquity, v, this.now());
  }

  private save(): void {
    if (this.state.fills.length > 500) this.state.fills = this.state.fills.slice(-500);
    if (this.state.closed.length > 200) this.state.closed = this.state.closed.slice(-200);
    kvSet(this.db, KV.shadowExchange, this.state, this.now());
  }

  /** Test/inspection hook. */
  snapshot(): SimState {
    return structuredClone(this.state);
  }

  async placeBracket(
    order: SizedOrder,
    ctx: PlaceContext,
  ): Promise<{ clientOrderId: string; strategyId: string }> {
    const side = order.direction === "long" ? "buy" : "sell";
    const exitSide = side === "buy" ? "sell" : "buy";
    const strategyId = clientOrderIds.strategy(ctx.positionId);
    const legs: SimOrder[] = [
      {
        clientOrderId: clientOrderIds.stop(ctx.positionId),
        positionId: ctx.positionId,
        symbol: order.symbol,
        side: exitSide,
        type: "stop",
        size: order.size,
        price: null,
        stopPrice: order.stopLoss,
        reduceOnly: true,
        strategyId,
        createdAt: ctx.now,
        status: "untriggered",
      },
      {
        clientOrderId: clientOrderIds.takeProfit(ctx.positionId),
        positionId: ctx.positionId,
        symbol: order.symbol,
        side: exitSide,
        type: "take_profit",
        size: order.size,
        price: null,
        stopPrice: order.takeProfit,
        reduceOnly: true,
        strategyId,
        createdAt: ctx.now,
        status: "untriggered",
      },
    ];
    const entry: SimOrder = {
      clientOrderId: clientOrderIds.entry(ctx.positionId),
      positionId: ctx.positionId,
      symbol: order.symbol,
      side,
      type: order.entryKind,
      size: order.size,
      price: order.entryKind === "limit" ? order.entryPrice : null,
      stopPrice: null,
      reduceOnly: false,
      strategyId,
      createdAt: ctx.now,
      status: "open",
      leverage: order.leverage,
    };
    this.state.orders.push(entry, ...legs);
    if (order.entryKind === "market") this.fillEntry(entry, ctx.markPrice, ctx.now, order.leverage);
    this.save();
    return { clientOrderId: entry.clientOrderId, strategyId };
  }

  private fillEntry(entry: SimOrder, price: number, at: number, leverage: number): SimPosition {
    this.state.orders = this.state.orders.filter((o) => o !== entry);
    for (const o of this.state.orders)
      if (o.positionId === entry.positionId && o.status === "untriggered") o.status = "open";
    const pos: SimPosition = {
      positionId: entry.positionId,
      symbol: entry.symbol,
      direction: entry.side === "buy" ? "long" : "short",
      size: entry.size,
      entryPrice: price,
      leverage,
      openedAt: at,
      lastFundingAt: at,
      fundingPaid: 0,
    };
    this.state.positions.push(pos);
    this.state.fills.push({
      clientOrderId: entry.clientOrderId,
      orderId: null,
      symbol: entry.symbol,
      side: entry.side,
      price,
      size: entry.size,
      fee: entry.type === "limit" ? 0 : price * entry.size * TAKER_FEE_RATE,
      realizedPnl: 0,
      time: at,
      role: entry.type === "limit" ? "maker" : "taker",
    });
    return pos;
  }

  private closePosition(pos: SimPosition, price: number, at: number, clientOrderId: string): void {
    const dir = pos.direction === "long" ? 1 : -1;
    const fee = price * pos.size * TAKER_FEE_RATE;
    const gross = dir * (price - pos.entryPrice) * pos.size;
    const entryFee =
      this.state.fills.find((f) => f.clientOrderId === clientOrderIds.entry(pos.positionId))?.fee ?? 0;
    const net = gross - fee - pos.fundingPaid;
    this.state.fills.push({
      clientOrderId,
      orderId: null,
      symbol: pos.symbol,
      side: pos.direction === "long" ? "sell" : "buy",
      price,
      size: pos.size,
      fee,
      realizedPnl: gross,
      time: at,
      role: "taker",
    });
    this.state.positions = this.state.positions.filter((p) => p !== pos);
    this.state.orders = this.state.orders.filter((o) => o.positionId !== pos.positionId);
    this.state.closed.push({
      positionId: pos.positionId,
      fundingPaid: pos.fundingPaid,
      fees: fee + entryFee,
      exitPrice: price,
      closedAt: at,
    });
    this.setEquity(this.equity + net - entryFee);
    this.log.info({ positionId: pos.positionId, price, net, via: clientOrderId }, "shadow position closed");
  }

  simulate(input: SimulateInput): void {
    const { mark, candle, now } = input;
    this.state.lastMark = mark;
    // 1. resting entries
    for (const entry of [...this.state.orders]) {
      if (entry.type !== "limit" || entry.status !== "open" || entry.price === null) continue;
      const long = entry.side === "buy";
      const touched = long
        ? mark <= entry.price || (candle !== null && candle.low <= entry.price)
        : mark >= entry.price || (candle !== null && candle.high >= entry.price);
      if (!touched) continue;
      const pos = this.fillEntry(entry, entry.price, now, entry.leverage ?? 1);
      this.log.info({ positionId: pos.positionId, price: entry.price }, "shadow entry filled");
    }
    // 2. funding accrual
    for (const pos of this.state.positions) {
      const boundaries = Math.floor(now / HOUR) - Math.floor(pos.lastFundingAt / HOUR);
      if (boundaries > 0) {
        const sign = pos.direction === "long" ? 1 : -1;
        pos.fundingPaid += boundaries * input.fundingRateHourly * pos.size * mark * sign;
        pos.lastFundingAt = now;
      }
    }
    // 3. stops first, then take-profits (same bar, conservative)
    for (const pos of [...this.state.positions]) {
      const legs = this.state.orders.filter(
        (o) => o.positionId === pos.positionId && o.status === "open" && o.reduceOnly,
      );
      const stop = legs.find((o) => o.type === "stop");
      const tp = legs.find((o) => o.type === "take_profit");
      const long = pos.direction === "long";
      const barAfterFill = candle !== null && candle.openTime >= pos.openedAt;
      const barOverlaps = candle !== null && candle.closeTime >= pos.openedAt;
      if (stop && stop.stopPrice !== null) {
        const hit = long
          ? mark <= stop.stopPrice || (barOverlaps && candle.low <= stop.stopPrice)
          : mark >= stop.stopPrice || (barOverlaps && candle.high >= stop.stopPrice);
        if (hit) {
          this.closePosition(pos, stop.stopPrice, now, stop.clientOrderId);
          continue;
        }
      }
      if (tp && tp.stopPrice !== null) {
        const hit = long
          ? mark >= tp.stopPrice || (barAfterFill && candle.high >= tp.stopPrice)
          : mark <= tp.stopPrice || (barAfterFill && candle.low <= tp.stopPrice);
        if (hit) this.closePosition(pos, tp.stopPrice, now, tp.clientOrderId);
      }
    }
    this.save();
  }

  async cancelResting(position: PositionRow): Promise<void> {
    this.state.orders = this.state.orders.filter((o) => o.positionId !== position.id);
    this.save();
  }

  async flatten(position: PositionRow, reason: string): Promise<void> {
    const pos = this.state.positions.find((p) => p.positionId === position.id);
    if (pos) {
      const mark = this.state.lastMark ?? pos.entryPrice;
      this.closePosition(pos, mark, this.now(), clientOrderIds.exit(position.id));
      this.log.warn({ positionId: position.id, reason }, "shadow position flattened");
    }
    this.state.orders = this.state.orders.filter((o) => o.positionId !== position.id);
    this.save();
  }

  async moveStop(position: PositionRow, newStop: number): Promise<void> {
    assertNotWider(position, newStop);
    const stop = this.state.orders.find((o) => o.positionId === position.id && o.type === "stop");
    if (stop) stop.stopPrice = newStop;
    else {
      this.state.orders.push({
        clientOrderId: clientOrderIds.stop(position.id, 1),
        positionId: position.id,
        symbol: position.symbol,
        side: position.direction === "long" ? "sell" : "buy",
        type: "stop",
        size: position.size,
        price: null,
        stopPrice: newStop,
        reduceOnly: true,
        strategyId: clientOrderIds.strategy(position.id),
        createdAt: this.now(),
        status: "open",
      });
    }
    this.save();
  }

  async view(symbol: string, fillsSince: number): Promise<ExchangeView> {
    const mark = this.state.lastMark;
    const positions: ExchangePosition[] = this.state.positions
      .filter((p) => p.symbol === symbol)
      .map((p) => ({
        symbol: p.symbol,
        direction: p.direction,
        size: p.size,
        entryPrice: p.entryPrice,
        leverage: p.leverage,
        liquidationPrice: null,
        unrealizedPnl: mark === null ? 0 : (p.direction === "long" ? 1 : -1) * (mark - p.entryPrice) * p.size,
      }));
    const openOrders: ExchangeOrder[] = this.state.orders
      .filter((o) => o.symbol === symbol)
      .map((o) => ({
        clientOrderId: o.clientOrderId,
        orderId: null,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        status: o.status,
        size: o.size,
        filled: 0,
        price: o.price,
        stopPrice: o.stopPrice,
        reduceOnly: o.reduceOnly,
        strategyId: o.strategyId,
        createdAt: o.createdAt,
      }));
    return {
      asOf: this.now(),
      positions,
      openOrders,
      fills: this.state.fills.filter((f) => f.symbol === symbol && f.time >= fillsSince),
    };
  }

  async account(symbol: string, now: number): Promise<AccountSnapshot> {
    const view = await this.view(symbol, 0);
    const unrealized = view.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const margin = view.positions.reduce((s, p) => s + (p.size * p.entryPrice) / Math.max(1, p.leverage), 0);
    const equity = Math.max(0, this.equity + unrealized);
    return {
      asOf: now,
      equity,
      availableBalance: Math.max(0, equity - margin),
      openPositions: view.positions.map((p) => ({
        symbol: p.symbol,
        direction: p.direction,
        size: p.size,
        entryPrice: p.entryPrice,
        leverage: p.leverage,
        liquidationPrice: null,
        unrealizedPnl: p.unrealizedPnl,
      })),
      openOrders: view.openOrders.filter((o) => !o.reduceOnly).length,
    };
  }

  async fundingPaid(position: PositionRow): Promise<number> {
    const open = this.state.positions.find((p) => p.positionId === position.id);
    if (open) return open.fundingPaid;
    return this.state.closed.find((c) => c.positionId === position.id)?.fundingPaid ?? position.fundingPaid;
  }
}
