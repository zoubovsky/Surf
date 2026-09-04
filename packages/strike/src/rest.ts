/**
 * Strike V2 REST client. Public market data lives under `${baseUrl}/price`; account, trading and
 * history endpoints live under `${baseUrl}` and are signed with the API wallet.
 *
 * - `fetch`, `clock` and `nonce` are injectable for tests.
 * - Idempotent GETs are retried with core `retry()`; order placement / cancels are never retried.
 * - Every response is validated with Zod; failures raise `StrikeParseError`.
 * - Decimal inputs given as numbers are formatted with the symbol's tick/step (from exchangeInfo or
 *   `/v2/markets/{symbol}`, falling back to the built-in BTC-USD rules).
 */
import { Candle, retry, systemClock } from "@surf/core";
import type { Clock, Interval, Logger } from "@surf/core";
import type { z } from "zod";
import { newNonce, signRequest, derivePublicKeyHex, type HexOrBytes } from "./auth.js";
import { StrikeApiError, StrikeConfigError, StrikeNetworkError, StrikeParseError } from "./errors.js";
import { formatPrice, formatSize } from "./precision.js";
import {
  BookTickerSchema,
  CancelAllAckSchema,
  CancelOrderAckSchema,
  ClosedPositionsSchema,
  CreateOrderAckSchema,
  CreateStrategyOrderAckSchema,
  DepthSchema,
  ExchangeInfoSchema,
  FeeTiersSchema,
  FillHistorySchema,
  FundingHistorySchema,
  KlinesSchema,
  LeverageAckSchema,
  MarginModeAckSchema,
  MarkPriceUpdateSchema,
  OpenInterestSchema,
  OpenOrdersSchema,
  OrderHistorySchema,
  PositionsResponseSchema,
  PremiumIndexSchema,
  ReplaceOrderAckSchema,
  StrikeAccountSchema,
  StrikeBalancesSchema,
  StrikeMarketSchema,
  StrikeOrderSchema,
  quoteBigIds,
  type BookTicker,
  type CancelAllAck,
  type CancelOrderAck,
  type CancelOrderRequest,
  type CreateOrderAck,
  type CreateOrderRequest,
  type CreateStrategyOrderAck,
  type CreateStrategyOrderRequest,
  type DecimalInput,
  type Depth,
  type ExchangeInfo,
  type FeeTiers,
  type KlineInterval,
  type LeverageAck,
  type MarginMode,
  type MarginModeAck,
  type MarkPriceUpdate,
  type OpenInterest,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type PremiumIndex,
  type PriceType,
  type ReplaceOrderAck,
  type ReplaceOrderRequest,
  type StrategyLegRequest,
  type StrikeAccount,
  type StrikeBalance,
  type StrikeClosedPosition,
  type StrikeFill,
  type StrikeFundingPayment,
  type StrikeKline,
  type StrikeMarket,
  type StrikeOrder,
  type StrikeOrderHistoryEntry,
  type StrikePosition,
  type SymbolRules,
} from "./schemas.js";

export const STRIKE_MAINNET_BASE = "https://api.strikefinance.org";
export const STRIKE_TESTNET_BASE = "https://api-v2-testnet.strikefinance.org";

/** Live BTC-USD rules (exchangeInfo, 2026-09-04). Used until exchangeInfo/market has been fetched. */
export const BTC_USD_RULES: SymbolRules = {
  symbol: "BTC-USD",
  tickSize: 0.1,
  priceDecimals: 1,
  minPrice: 10,
  maxPrice: 100_000,
  stepSize: 0.00001,
  sizeDecimals: 5,
  minQty: 0.00001,
  maxQty: 1000,
  marketStepSize: 0.00001,
  marketMinQty: 0.00001,
  marketMaxQty: 120,
  minNotional: 10,
  limitTakeBound: 0.05,
  marketTakeBound: 0.05,
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface StrikeCredentials {
  privateKey: HexOrBytes;
  /** Derived from the private key when omitted. */
  publicKey?: HexOrBytes | undefined;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
}

export interface StrikeRestClientOptions {
  baseUrl?: string | undefined;
  /** Defaults to `${baseUrl}/price`. */
  marketBaseUrl?: string | undefined;
  credentials?: StrikeCredentials | undefined;
  fetch?: FetchLike | undefined;
  clock?: Clock | undefined;
  nonce?: (() => string) | undefined;
  logger?: Logger | undefined;
  retry?: RetryOptions | undefined;
  timeoutMs?: number | undefined;
  /** Seed the per-symbol rules cache (e.g. from a previous exchangeInfo). BTC-USD is built in. */
  symbolRules?: readonly SymbolRules[] | undefined;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface KlinesParams {
  symbol: string;
  interval: KlineInterval;
  priceType?: PriceType | undefined;
  /** Unix ms, inclusive. */
  startTime?: number | undefined;
  /** Unix ms, inclusive. */
  endTime?: number | undefined;
  /** Clamped to 1500 by the server. */
  limit?: number | undefined;
}

export interface CandleParams extends Omit<KlinesParams, "interval"> {
  interval: Interval;
}

export interface OrderHistoryParams {
  symbol?: string | undefined;
  side?: OrderSide | undefined;
  type?: OrderType | undefined;
  /** Accepts the status name or the venue's integer (1 pending .. 7 expired). */
  status?: Exclude<OrderStatus, "none"> | number | undefined;
  order_id?: number | undefined;
  source?: "twap" | "grid" | "copy" | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  /** Clamped to 1000. */
  limit?: number | undefined;
  /** Backward cursor: orders with id < this value. */
  fromOrderID?: number | undefined;
}

export interface FillHistoryParams {
  symbol?: string | undefined;
  side?: OrderSide | undefined;
  role?: "maker" | "taker" | undefined;
  auto_close_type?: string | undefined;
  order_id?: number | undefined;
  source?: "twap" | "grid" | "copy" | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
  /** Backward cursor (internal id < value). Cannot be combined with since_trade_id. */
  fromId?: number | undefined;
  /** Forward cursor (trade_id > value, ascending) for polling new fills. */
  since_trade_id?: number | undefined;
}

export interface FundingHistoryParams {
  symbol?: string | undefined;
  position_side?: "Long" | "Short" | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
  fromId?: number | undefined;
}

export interface ClosedPositionsParams {
  symbol?: string | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

const ORDER_STATUS_CODES: Record<Exclude<OrderStatus, "none">, number> = {
  pending: 1,
  open: 2,
  filled: 3,
  canceled: 4,
  untriggered: 5,
  rejected: 6,
  expired: 7,
};

const DECIMAL_RE = /^\d+(\.\d+)?$/;

function decimalString(value: DecimalInput, field: string, format: (n: number) => string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw new StrikeConfigError(`${field} must be a finite non-negative number`);
    return format(value);
  }
  const s = value.trim();
  if (!DECIMAL_RE.test(s))
    throw new StrikeConfigError(`${field} must be a decimal string, got ${JSON.stringify(value)}`);
  return s;
}

/** Convert numeric size/price fields to correctly-rounded strings and drop undefined keys. */
export function serializeCreateOrder(req: CreateOrderRequest, rules: SymbolRules): Record<string, unknown> {
  const step = req.type === "market" ? (rules.marketStepSize ?? rules.stepSize) : rules.stepSize;
  const out: Record<string, unknown> = {
    ...req,
    size: decimalString(req.size, "size", (n) => formatSize(n, step)),
  };
  if (out["size"] === formatSize(0, step))
    throw new StrikeConfigError("size rounds to zero at the symbol step");
  for (const key of ["price", "stop_price", "activation_price"] as const) {
    const v = req[key];
    if (v !== undefined) out[key] = decimalString(v, key, (n) => formatPrice(n, rules.tickSize));
  }
  return stripUndefined(out);
}

export function serializeStrategyLeg(leg: StrategyLegRequest, rules: SymbolRules): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...leg,
    size: decimalString(leg.size, "size", (n) => formatSize(n, rules.stepSize)),
    stop_price: decimalString(leg.stop_price, "stop_price", (n) => formatPrice(n, rules.tickSize)),
  };
  if (leg.price !== undefined)
    out["price"] = decimalString(leg.price, "price", (n) => formatPrice(n, rules.tickSize));
  return stripUndefined(out);
}

export function serializeStrategyOrder(
  req: CreateStrategyOrderRequest,
  rules: SymbolRules,
): Record<string, unknown> {
  if (!req.tp_order && !req.sl_order)
    throw new StrikeConfigError("strategy order needs tp_order and/or sl_order");
  const { tp_order, sl_order, ...primary } = req;
  const out = serializeCreateOrder({ ...primary, type: req.type } as CreateOrderRequest, rules);
  out["strategy_id"] = req.strategy_id;
  if (tp_order) out["tp_order"] = serializeStrategyLeg(tp_order, rules);
  if (sl_order) out["sl_order"] = serializeStrategyLeg(sl_order, rules);
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

const STOP: unique symbol = Symbol("stop-retry");

export class StrikeRestClient {
  readonly baseUrl: string;
  readonly marketBaseUrl: string;
  private readonly credentials: StrikeCredentials | undefined;
  private readonly publicKeyHex: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly nonce: () => string;
  private readonly logger: Logger | undefined;
  private readonly retryOpts: Required<RetryOptions>;
  private readonly timeoutMs: number;
  private readonly rules = new Map<string, SymbolRules>();

  constructor(opts: StrikeRestClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? STRIKE_MAINNET_BASE).replace(/\/+$/, "");
    this.marketBaseUrl = (opts.marketBaseUrl ?? `${this.baseUrl}/price`).replace(/\/+$/, "");
    this.credentials = opts.credentials;
    this.publicKeyHex = opts.credentials
      ? opts.credentials.publicKey
        ? typeof opts.credentials.publicKey === "string"
          ? opts.credentials.publicKey.toLowerCase()
          : Buffer.from(opts.credentials.publicKey).toString("hex")
        : derivePublicKeyHex(opts.credentials.privateKey)
      : undefined;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.clock = opts.clock ?? systemClock;
    this.nonce = opts.nonce ?? newNonce;
    this.logger = opts.logger;
    this.retryOpts = {
      attempts: opts.retry?.attempts ?? 3,
      baseMs: opts.retry?.baseMs ?? 300,
      maxMs: opts.retry?.maxMs ?? 4000,
    };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.rules.set(BTC_USD_RULES.symbol, BTC_USD_RULES);
    for (const r of opts.symbolRules ?? []) this.rules.set(r.symbol, r);
  }

  get hasCredentials(): boolean {
    return this.credentials !== undefined;
  }

  /** API-wallet public key (hex) when credentials are configured. */
  get publicKey(): string | undefined {
    return this.publicKeyHex;
  }

  /** Cached trading rules for a symbol (built-in BTC-USD until exchangeInfo/market is fetched). */
  cachedRules(symbol: string): SymbolRules | undefined {
    return this.rules.get(symbol);
  }

  /** Rules for a symbol, fetching exchangeInfo when not cached. */
  async symbolRules(symbol: string): Promise<SymbolRules> {
    const cached = this.rules.get(symbol);
    if (cached) return cached;
    await this.exchangeInfo();
    const rules = this.rules.get(symbol);
    if (!rules) throw new StrikeConfigError(`symbol ${symbol} not listed in exchangeInfo`);
    return rules;
  }

  // ------------------------------------------------------------------ public market data

  async ping(): Promise<void> {
    await this.getTrade("/v2/ping", undefined, undefined);
  }

  async serverTime(): Promise<number> {
    const r = (await this.getTrade("/v2/time", undefined, undefined)) as { serverTime?: number };
    if (typeof r.serverTime !== "number") throw new StrikeParseError("/v2/time", "missing serverTime", r);
    return r.serverTime;
  }

  async exchangeInfo(): Promise<ExchangeInfo> {
    const info = await this.getMarket("/v2/exchangeInfo", undefined, ExchangeInfoSchema);
    for (const s of info.symbols) this.rules.set(s.symbol, s.rules);
    return info;
  }

  premiumIndex(symbol: string): Promise<PremiumIndex> {
    return this.getMarket("/v2/premiumIndex", { symbol }, PremiumIndexSchema);
  }

  markPrice(symbol: string): Promise<MarkPriceUpdate> {
    return this.getMarket("/v2/markPrice", { symbol }, MarkPriceUpdateSchema);
  }

  bookTicker(symbol: string): Promise<BookTicker> {
    return this.getMarket("/v2/ticker/bookTicker", { symbol }, BookTickerSchema);
  }

  /** Order book snapshot (server-cached 5s). `limit` 1..1000. */
  depth(symbol: string, limit = 100): Promise<Depth> {
    return this.getMarket("/v2/depth", { symbol, limit }, DepthSchema, quoteBigIds);
  }

  /** Raw Binance-style klines for any supported interval. The last row may be the still-open bar. */
  klinesRaw(params: KlinesParams): Promise<StrikeKline[]> {
    return this.getMarket(
      "/v2/klines",
      {
        symbol: params.symbol,
        interval: params.interval,
        priceType: params.priceType,
        startTime: params.startTime,
        endTime: params.endTime,
        limit: params.limit,
      },
      KlinesSchema,
    );
  }

  /**
   * Klines mapped to core `Candle` (venue "strike"). Only core intervals (1h/4h/1d) are accepted.
   * Callers that need strictly closed candles should drop rows with `closeTime > now`.
   */
  async klines(params: CandleParams): Promise<Candle[]> {
    const rows = await this.klinesRaw(params);
    return rows.map((k) =>
      Candle.parse({
        venue: "strike",
        symbol: params.symbol,
        interval: params.interval,
        openTime: k.openTime,
        closeTime: k.closeTime,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      }),
    );
  }

  openInterest(symbol: string): Promise<OpenInterest> {
    return this.getMarket("/v2/openInterest", { symbol }, OpenInterestSchema);
  }

  /** Semi-official `/v2/markets/{symbol}`: margin tiers, price bounds, top of book. Caches rules. */
  async market(symbol: string): Promise<StrikeMarket> {
    const m = await this.getTrade(`/v2/markets/${encodeURIComponent(symbol)}`, undefined, StrikeMarketSchema);
    this.rules.set(m.symbol, m.rules);
    return m;
  }

  feeTiers(): Promise<FeeTiers> {
    return this.getTrade("/v2/fee-tiers", undefined, FeeTiersSchema);
  }

  // ------------------------------------------------------------------ account (auth)

  account(): Promise<StrikeAccount> {
    return this.getAuth("/v2/account", undefined, StrikeAccountSchema);
  }

  balances(): Promise<StrikeBalance[]> {
    return this.getAuth("/v2/balances", undefined, StrikeBalancesSchema);
  }

  /** Open positions (size != 0). */
  async positions(symbol?: string): Promise<StrikePosition[]> {
    const all = await this.getAuth("/v2/positions", { symbol }, PositionsResponseSchema);
    return all.filter((p) => p.size !== 0);
  }

  openOrders(symbol?: string): Promise<StrikeOrder[]> {
    return this.getAuth("/v2/openOrders", { symbol }, OpenOrdersSchema);
  }

  getOrder(params: {
    symbol: string;
    client_order_id?: string | undefined;
    order_id?: number | undefined;
  }): Promise<StrikeOrder> {
    if (params.client_order_id === undefined && params.order_id === undefined) {
      throw new StrikeConfigError("getOrder needs client_order_id or order_id");
    }
    return this.getAuth(
      "/v2/order",
      { symbol: params.symbol, client_order_id: params.client_order_id, order_id: params.order_id },
      StrikeOrderSchema,
    );
  }

  // ------------------------------------------------------------------ trading (auth, never retried)

  /**
   * Place one order. The 201 response is an acknowledgement only (no server order id); track the
   * order via `client_order_id` on the user stream or `getOrder`. Always set `client_order_id`.
   */
  async createOrder(req: CreateOrderRequest): Promise<CreateOrderAck> {
    const rules = await this.symbolRules(req.symbol);
    return this.send("POST", "/v2/order", serializeCreateOrder(req, rules), CreateOrderAckSchema);
  }

  /** Bracket (OTOCO): primary limit/market entry with dormant TP and/or SL legs. */
  async createStrategyOrder(req: CreateStrategyOrderRequest): Promise<CreateStrategyOrderAck> {
    const rules = await this.symbolRules(req.symbol);
    return this.send(
      "POST",
      "/v2/order/strategy",
      serializeStrategyOrder(req, rules),
      CreateStrategyOrderAckSchema,
    );
  }

  /** Atomic cancel + create. The cancel runs first; if it fails nothing is placed. */
  async replaceOrder(req: ReplaceOrderRequest): Promise<ReplaceOrderAck> {
    if (!req.cancel && !req.new_order)
      throw new StrikeConfigError("replaceOrder needs cancel and/or new_order");
    const body: Record<string, unknown> = stripUndefined({
      vault_id: req.vault_id,
      sub_account_id: req.sub_account_id,
    });
    if (req.cancel) body["cancel"] = stripUndefined({ ...req.cancel });
    if (req.new_order)
      body["new_order"] = serializeCreateOrder(req.new_order, await this.symbolRules(req.new_order.symbol));
    return this.send("POST", "/v2/order/replace", body, ReplaceOrderAckSchema);
  }

  cancelOrder(req: CancelOrderRequest): Promise<CancelOrderAck> {
    return this.send("DELETE", "/v2/order/cancel", stripUndefined({ ...req }), CancelOrderAckSchema);
  }

  /** Cancel every open order, optionally for one symbol. `canceledCount === -1` means async. */
  cancelAll(symbol?: string): Promise<CancelAllAck> {
    return this.send("DELETE", "/v2/order/cancel-all", stripUndefined({ symbol }), CancelAllAckSchema);
  }

  /** Affects new positions only. */
  setLeverage(symbol: string, leverage: number): Promise<LeverageAck> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      throw new StrikeConfigError("leverage must be an integer in 1..125");
    }
    return this.send("POST", "/v2/leverage", { symbol, leverage }, LeverageAckSchema);
  }

  /** Only allowed while flat on the symbol. */
  setMarginMode(symbol: string, marginMode: MarginMode): Promise<MarginModeAck> {
    return this.send("POST", "/v2/marginMode", { symbol, marginMode }, MarginModeAckSchema);
  }

  // ------------------------------------------------------------------ history (auth)

  orderHistory(params: OrderHistoryParams = {}): Promise<StrikeOrderHistoryEntry[]> {
    const status = typeof params.status === "string" ? ORDER_STATUS_CODES[params.status] : params.status;
    return this.getAuth("/v2/history/order", { ...params, status }, OrderHistorySchema);
  }

  fillHistory(params: FillHistoryParams = {}): Promise<StrikeFill[]> {
    if (params.fromId !== undefined && params.since_trade_id !== undefined) {
      throw new StrikeConfigError("fillHistory: fromId and since_trade_id cannot be combined");
    }
    return this.getAuth("/v2/history/fill", { ...params }, FillHistorySchema);
  }

  fundingHistory(params: FundingHistoryParams = {}): Promise<StrikeFundingPayment[]> {
    return this.getAuth("/v2/history/funding", { ...params }, FundingHistorySchema);
  }

  closedPositions(params: ClosedPositionsParams = {}): Promise<StrikeClosedPosition[]> {
    return this.getAuth("/v2/closedPositions", { ...params }, ClosedPositionsSchema);
  }

  // ------------------------------------------------------------------ internals

  private getMarket<T>(
    path: string,
    query: Query | undefined,
    schema: z.ZodType<T, unknown>,
    pre?: (t: string) => string,
  ): Promise<T> {
    return this.withRetry(() =>
      this.request({ base: this.marketBaseUrl, method: "GET", path, query, auth: false, schema, pre }),
    );
  }

  private getTrade<T>(
    path: string,
    query: Query | undefined,
    schema: z.ZodType<T, unknown> | undefined,
  ): Promise<T> {
    return this.withRetry(() =>
      this.request({ base: this.baseUrl, method: "GET", path, query, auth: false, schema }),
    );
  }

  private getAuth<T>(path: string, query: Query | undefined, schema: z.ZodType<T, unknown>): Promise<T> {
    this.requireCredentials();
    return this.withRetry(() =>
      this.request({ base: this.baseUrl, method: "GET", path, query, auth: true, schema }),
    );
  }

  private send<T>(
    method: "POST" | "DELETE",
    path: string,
    body: unknown,
    schema: z.ZodType<T, unknown>,
  ): Promise<T> {
    this.requireCredentials();
    return this.request({ base: this.baseUrl, method, path, body, auth: true, schema });
  }

  private requireCredentials(): void {
    if (!this.credentials) throw new StrikeConfigError("this endpoint requires API-wallet credentials");
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let fatal: unknown;
    const result = await retry<T | typeof STOP>(
      async () => {
        try {
          return await fn();
        } catch (err) {
          const retryable =
            (err instanceof StrikeApiError && err.isRetryable) || err instanceof StrikeNetworkError;
          if (retryable) throw err;
          fatal = err;
          return STOP;
        }
      },
      {
        attempts: this.retryOpts.attempts,
        baseMs: this.retryOpts.baseMs,
        maxMs: this.retryOpts.maxMs,
        onError: (err, attempt) => this.logger?.warn({ err, attempt }, "strike request failed, retrying"),
      },
    );
    if (result === STOP) throw fatal;
    return result;
  }

  private async request<T>(args: {
    base: string;
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Query | undefined;
    body?: unknown;
    auth: boolean;
    schema: z.ZodType<T, unknown> | undefined;
    pre?: ((text: string) => string) | undefined;
  }): Promise<T> {
    const pathWithQuery = args.path + buildQuery(args.query);
    const url = args.base + pathWithQuery;
    // Serialise once; the same bytes are hashed for the signature and sent on the wire.
    const bodyStr = args.body === undefined ? undefined : JSON.stringify(args.body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bodyStr !== undefined) headers["Content-Type"] = "application/json";
    if (args.auth && this.credentials) {
      const signed = signRequest({
        method: args.method,
        path: pathWithQuery,
        body: bodyStr,
        timestamp: Math.floor(this.clock.now() / 1000),
        nonce: this.nonce(),
        privateKey: this.credentials.privateKey,
        publicKey: this.credentials.publicKey,
      });
      Object.assign(headers, signed.headers);
    }
    const init: RequestInit = { method: args.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (bodyStr !== undefined) init.body = bodyStr;
    this.logger?.debug({ method: args.method, url }, "strike request");

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new StrikeNetworkError(
        `${args.method} ${pathWithQuery} failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw StrikeApiError.fromResponse({
        status: res.status,
        bodyText: text,
        requestId: res.headers.get("x-request-id") ?? undefined,
        method: args.method,
        path: pathWithQuery,
      });
    }
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(args.pre ? args.pre(text) : text);
      } catch {
        throw new StrikeParseError(pathWithQuery, "response is not JSON", text.slice(0, 200));
      }
    }
    if (!args.schema) return data as T;
    const parsed = args.schema.safeParse(data);
    if (!parsed.success) throw new StrikeParseError(pathWithQuery, parsed.error.issues, data);
    return parsed.data;
  }
}
