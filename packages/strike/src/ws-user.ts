/**
 * Authenticated user stream (`wss://api.strikefinance.org/ws/user-api`).
 *
 * Flow: open -> `session.logon` (Ed25519 over the logon payload) -> `subscribe userstream` with the
 * `account_id` returned by the logon -> events `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`,
 * `strategyUpdate`. Close codes 1008/4001/4003/4401/4403 mean the credentials were rejected; we stop
 * reconnecting and emit `giveUp`.
 */
import { z } from "zod";
import { userStreamLogon, type HexOrBytes, type LogonMessageFormat } from "./auth.js";
import { dec, decOrNull, int } from "./schemas.js";
import { ReconnectingSocket, type BaseEvents, type ReconnectingSocketOptions } from "./ws-base.js";

export const STRIKE_USER_WS_MAINNET = "wss://api.strikefinance.org/ws/user-api";
export const STRIKE_USER_WS_TESTNET = "wss://api-v2-testnet.strikefinance.org/ws/user-api";

export const USER_WS_AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([1008, 4001, 4003, 4401, 4403]);

export type WsOrderStatus =
  | "NEW"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "UNTRIGGERED"
  | (string & {});

export const WS_FINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "FILLED",
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

export interface OrderTradeUpdate {
  eventTime: number;
  transactionTime: number;
  symbol: string;
  clientOrderId: string;
  orderId: number;
  side: "BUY" | "SELL";
  orderType: string;
  timeInForce: string | null;
  originalQty: number;
  originalPrice: number;
  status: WsOrderStatus;
  executionType: string;
  cumulativeFilledQty: number;
  lastFilledQty: number;
  lastFilledPrice: number;
  averagePrice: number | null;
  commission: number | null;
  commissionAsset: string | null;
  tradeId: number;
  isMaker: boolean;
  reduceOnly: boolean;
  closePosition: boolean;
  stopPrice: number | null;
  workingType: string | null;
  activationPrice: number | null;
  callbackRate: number | null;
  realizedProfit: number | null;
  /** t > 0 with quantity, price and commission present: a genuine execution, not a status echo. */
  isFill: boolean;
  isFinal: boolean;
}

const OrderTradeUpdateSchema = z.looseObject({
  s: z.string(),
  c: z.string().optional(),
  i: int,
  S: z.enum(["BUY", "SELL"]),
  o: z.string(),
  f: z.string().nullable().optional(),
  q: dec,
  p: decOrNull,
  X: z.string(),
  x: z.string().optional(),
  z: decOrNull,
  l: decOrNull,
  L: decOrNull,
  ap: decOrNull,
  n: decOrNull,
  N: z.string().nullable().optional(),
  t: int.optional(),
  m: z.boolean().optional(),
  R: z.boolean().optional(),
  cp: z.boolean().optional(),
  sp: decOrNull,
  wt: z.string().nullable().optional(),
  AP: decOrNull,
  CR: decOrNull,
  rp: decOrNull,
  T: int.optional(),
  E: int.optional(),
});

export function parseOrderTradeUpdate(data: unknown, eventTime: number): OrderTradeUpdate | null {
  const r = OrderTradeUpdateSchema.safeParse(data);
  if (!r.success) return null;
  const d = r.data;
  const tradeId = d.t ?? 0;
  const lastQty = d.l ?? 0;
  const lastPrice = d.L ?? 0;
  const isFill =
    tradeId > 0 &&
    lastQty > 0 &&
    lastPrice > 0 &&
    (d.X === "FILLED" || d.X === "PARTIALLY_FILLED" || d.x === "TRADE");
  return {
    eventTime: d.E ?? eventTime,
    transactionTime: d.T ?? d.E ?? eventTime,
    symbol: d.s,
    clientOrderId: d.c ?? "",
    orderId: d.i,
    side: d.S,
    orderType: d.o,
    timeInForce: d.f ?? null,
    originalQty: d.q,
    originalPrice: d.p ?? 0,
    status: d.X,
    executionType: d.x ?? "",
    cumulativeFilledQty: d.z ?? 0,
    lastFilledQty: lastQty,
    lastFilledPrice: lastPrice,
    averagePrice: d.ap,
    commission: d.n,
    commissionAsset: d.N ?? null,
    tradeId,
    isMaker: d.m ?? false,
    reduceOnly: d.R ?? false,
    closePosition: d.cp ?? false,
    stopPrice: d.sp,
    workingType: d.wt ?? null,
    activationPrice: d.AP,
    callbackRate: d.CR,
    realizedProfit: d.rp,
    isFill,
    isFinal: WS_FINAL_ORDER_STATUSES.has(d.X),
  };
}

export interface WsBalanceUpdate {
  asset: string;
  walletBalance: number;
  crossWalletBalance: number | null;
  balanceChange: number | null;
}

export interface WsPositionUpdate {
  symbol: string;
  /** Signed amount: positive long, negative short, 0 closed. */
  positionAmount: number;
  entryPrice: number;
  marginType: "cross" | "isolated" | null;
  isolatedBalance: number | null;
  positionSide: "LONG" | "SHORT" | "BOTH" | null;
  positionId: string | null;
}

export interface AccountUpdate {
  eventTime: number;
  transactionTime: number;
  /** ORDER, FUNDING, DEPOSIT, WITHDRAW, PARTIAL_LIQUIDATED, FULLY_LIQUIDATED, ADL, ... */
  reason: string;
  balances: WsBalanceUpdate[];
  positions: WsPositionUpdate[];
  /** Present for vault/transaction status events instead of B/P. */
  eventType: string | null;
  eventData: unknown;
}

const AccountUpdateSchema = z.looseObject({
  e: z.string().optional(),
  E: int.optional(),
  T: int.optional(),
  r: z.string().optional(),
  m: z.string().optional(),
  B: z
    .array(z.looseObject({ a: z.string(), wb: dec, cw: decOrNull, bc: decOrNull }))
    .nullable()
    .optional(),
  P: z
    .array(
      z.looseObject({
        s: z.string(),
        pa: dec,
        ep: decOrNull,
        mt: z.string().nullable().optional(),
        ib: decOrNull,
        ps: z.string().nullable().optional(),
        i: z.union([z.string(), z.number()]).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  event_type: z.string().optional(),
  event_data: z.unknown().optional(),
});

export function parseAccountUpdate(data: unknown, eventTime: number): AccountUpdate | null {
  const r = AccountUpdateSchema.safeParse(data);
  if (!r.success) return null;
  const d = r.data;
  const mt = (v: string | null | undefined): "cross" | "isolated" | null =>
    v === "cross" || v === "isolated" ? v : null;
  const ps = (v: string | null | undefined): "LONG" | "SHORT" | "BOTH" | null =>
    v === "LONG" || v === "SHORT" || v === "BOTH" ? v : null;
  return {
    eventTime: d.E ?? eventTime,
    transactionTime: d.T ?? d.E ?? eventTime,
    reason: d.r ?? d.m ?? d.e ?? "",
    balances: (d.B ?? []).map((b) => ({
      asset: b.a,
      walletBalance: b.wb,
      crossWalletBalance: b.cw,
      balanceChange: b.bc,
    })),
    positions: (d.P ?? []).map((p) => ({
      symbol: p.s,
      positionAmount: p.pa,
      entryPrice: p.ep ?? 0,
      marginType: mt(p.mt),
      isolatedBalance: p.ib,
      positionSide: ps(p.ps),
      positionId: p.i === null || p.i === undefined ? null : String(p.i),
    })),
    eventType: d.event_type ?? null,
    eventData: d.event_data,
  };
}

export interface StrategyUpdate {
  eventTime: number;
  accountId: string;
  strategyId: string;
  market: string;
  status: string;
  side: string | null;
  filledSize: number | null;
  totalSize: number | null;
  lastError: string | null;
  completedAt: number | null;
  raw: Record<string, unknown>;
}

const StrategyUpdateSchema = z.looseObject({
  account_id: z.string().optional(),
  strategy_id: z.string(),
  market: z.string().optional(),
  symbol: z.string().optional(),
  status: z.string(),
  side: z.string().nullable().optional(),
  filled_size: decOrNull,
  total_size: decOrNull,
  last_error: z.string().nullable().optional(),
  completed_at_ms: int.nullable().optional(),
});

export function parseStrategyUpdate(
  data: unknown,
  eventTime: number,
  symbol?: string,
): StrategyUpdate | null {
  const r = StrategyUpdateSchema.safeParse(data);
  if (!r.success) return null;
  const d = r.data;
  return {
    eventTime,
    accountId: d.account_id ?? "",
    strategyId: d.strategy_id,
    market: d.market ?? d.symbol ?? symbol ?? "",
    status: d.status,
    side: d.side ?? null,
    filledSize: d.filled_size,
    totalSize: d.total_size,
    lastError: d.last_error || null,
    completedAt: d.completed_at_ms ?? null,
    raw: d as Record<string, unknown>,
  };
}

export interface UserStreamEvents extends BaseEvents {
  authenticated: { accountId: string };
  subscribed: { accountId: string };
  /** Logon or subscribe rejected by the server (status != 200). */
  authError: { status: number | null; message: string };
  orderUpdate: OrderTradeUpdate;
  accountUpdate: AccountUpdate;
  strategyUpdate: StrategyUpdate;
}

export interface StrikeUserStreamOptions extends Partial<Omit<ReconnectingSocketOptions, "url">> {
  url?: string | undefined;
  privateKey: HexOrBytes;
  /** Public key hex; derived when omitted. */
  publicKey?: string | undefined;
  /** Use a known account id instead of the one returned by the logon. */
  accountId?: string | undefined;
  logonFormat?: LogonMessageFormat | undefined;
  now?: (() => number) | undefined;
}

export class StrikeUserStream extends ReconnectingSocket<UserStreamEvents> {
  private readonly privateKey: HexOrBytes;
  private readonly publicKeyHex: string | undefined;
  private readonly configuredAccountId: string | undefined;
  private readonly logonFormat: LogonMessageFormat | undefined;
  private readonly now: () => number;
  private logonId: number | null = null;
  private subscribeId: number | null = null;
  private _accountId: string | null = null;
  private _authenticated = false;
  private _subscribed = false;

  constructor(opts: StrikeUserStreamOptions) {
    super({ ...opts, url: opts.url ?? STRIKE_USER_WS_MAINNET });
    this.privateKey = opts.privateKey;
    this.publicKeyHex = opts.publicKey;
    this.configuredAccountId = opts.accountId;
    this.logonFormat = opts.logonFormat;
    this.now = opts.now ?? Date.now;
  }

  get accountId(): string | null {
    return this._accountId ?? this.configuredAccountId ?? null;
  }

  get authenticated(): boolean {
    return this._authenticated && this.isOpen;
  }

  get subscribed(): boolean {
    return this._subscribed && this.isOpen;
  }

  protected onOpen(): void {
    this._authenticated = false;
    this._subscribed = false;
    this.logonId = this.allocId();
    const { message } = userStreamLogon({
      privateKey: this.privateKey,
      apiKey: this.publicKeyHex,
      timestampMs: this.now(),
      id: this.logonId,
      format: this.logonFormat,
    });
    this.send(message);
  }

  protected override isFatalClose(code: number): boolean {
    return USER_WS_AUTH_CLOSE_CODES.has(code);
  }

  protected onMessage(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const v = value as Record<string, unknown>;

    if ("id" in v && !("e" in v)) {
      this.handleReply(v);
      return;
    }

    const eventTime = typeof v["E"] === "number" ? v["E"] : this.now();
    const data = v["data"] ?? v;
    switch (v["e"]) {
      case "ORDER_TRADE_UPDATE": {
        const ev = parseOrderTradeUpdate(data, eventTime);
        if (ev) this.emit("orderUpdate", ev);
        else this.logger?.warn({ v }, "strike user ws: bad ORDER_TRADE_UPDATE");
        return;
      }
      case "ACCOUNT_UPDATE": {
        const ev = parseAccountUpdate(data, eventTime);
        if (ev) this.emit("accountUpdate", ev);
        else this.logger?.warn({ v }, "strike user ws: bad ACCOUNT_UPDATE");
        return;
      }
      case "strategyUpdate": {
        const ev = parseStrategyUpdate(data, eventTime, typeof v["s"] === "string" ? v["s"] : undefined);
        if (ev) this.emit("strategyUpdate", ev);
        else this.logger?.warn({ v }, "strike user ws: bad strategyUpdate");
        return;
      }
      default:
        return;
    }
  }

  private handleReply(v: Record<string, unknown>): void {
    const id = v["id"];
    const status = typeof v["status"] === "number" ? v["status"] : null;
    const result = (v["result"] ?? null) as Record<string, unknown> | null;
    const errorMsg = extractError(v);

    if (id === this.logonId) {
      const ok =
        errorMsg === null && (status === null || status === 200) && result?.["authenticated"] !== false;
      if (!ok) {
        this._authenticated = false;
        this.emit("authError", { status, message: errorMsg ?? `logon rejected (status ${status})` });
        this.logger?.error({ status, errorMsg }, "strike user ws: logon rejected");
        return;
      }
      const accountId =
        typeof result?.["account_id"] === "string" ? result["account_id"] : this.configuredAccountId;
      this._authenticated = true;
      if (!accountId) {
        this.emit("authError", { status, message: "logon succeeded but no account_id available" });
        return;
      }
      this._accountId = accountId;
      this.emit("authenticated", { accountId });
      this.subscribeId = this.allocId();
      this.send({ method: "subscribe", channel: "userstream", account_id: accountId, id: this.subscribeId });
      return;
    }

    if (id === this.subscribeId) {
      if (errorMsg !== null || (status !== null && status !== 200)) {
        this._subscribed = false;
        this.emit("authError", { status, message: errorMsg ?? `subscribe rejected (status ${status})` });
        return;
      }
      this._subscribed = true;
      this.emit("subscribed", { accountId: this.accountId ?? "" });
    }
  }
}

function extractError(v: Record<string, unknown>): string | null {
  const e = v["error"];
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return String(o["msg"] ?? o["message"] ?? JSON.stringify(e));
  }
  if (typeof v["msg"] === "string" && v["status"] !== 200 && v["status"] !== undefined) return v["msg"];
  return null;
}
