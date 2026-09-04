import { describe, expect, it } from "vitest";
import { verifyRequestSignature, type AuthHeaders } from "./auth.js";
import { StrikeApiError, StrikeConfigError, StrikeParseError } from "./errors.js";
import { StrikeRestClient, serializeCreateOrder, serializeStrategyOrder, BTC_USD_RULES } from "./rest.js";
import {
  accountFixture,
  balancesFixture,
  bookTickerFixture,
  closedPositionsFixture,
  createOrderAckFixture,
  createStrategyAckFixture,
  depthFixtureText,
  exchangeInfoFixture,
  feeTiersFixture,
  fillHistoryFixture,
  fundingHistoryFixture,
  klinesFixture,
  marketFixture,
  markPriceFixture,
  openInterestFixture,
  openOrdersFixture,
  orderHistoryFixture,
  positionsFixture,
  positionsPascalFixture,
  premiumIndexFixture,
} from "./fixtures/index.js";

const SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const NOW_MS = 1_788_540_000_123;
const NONCE = "550e8400-e29b-41d4-a716-446655440000";

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function harness(responses: (Response | Error)[], opts: { auth?: boolean } = {}) {
  const calls: Call[] = [];
  const queue = [...responses];
  const client = new StrikeRestClient({
    baseUrl: "https://example.test",
    credentials: opts.auth === false ? undefined : { privateKey: SK },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error("no more fake responses");
      if (next instanceof Error) throw next;
      return next;
    },
    clock: { now: () => NOW_MS },
    nonce: () => NONCE,
    retry: { attempts: 3, baseMs: 1, maxMs: 2 },
  });
  return { client, calls };
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function authHeaders(call: Call): AuthHeaders {
  const h = headersOf(call);
  return {
    "X-API-Wallet-Public-Key": h["X-API-Wallet-Public-Key"]!,
    "X-API-Wallet-Signature": h["X-API-Wallet-Signature"]!,
    "X-API-Wallet-Timestamp": h["X-API-Wallet-Timestamp"]!,
    "X-API-Wallet-Nonce": h["X-API-Wallet-Nonce"]!,
  };
}

describe("request building", () => {
  it("public GET goes to the /price base with a query string and no auth headers", async () => {
    const { client, calls } = harness([json(premiumIndexFixture)], { auth: false });
    await client.premiumIndex("BTC-USD");
    expect(calls[0]!.url).toBe("https://example.test/price/v2/premiumIndex?symbol=BTC-USD");
    expect(calls[0]!.init.method).toBe("GET");
    expect(headersOf(calls[0]!)["X-API-Wallet-Signature"]).toBeUndefined();
  });

  it("authenticated GET signs METHOD:PATH_WITH_QUERY with the injected clock and nonce", async () => {
    const { client, calls } = harness([json(openOrdersFixture)]);
    await client.openOrders("BTC-USD");
    const call = calls[0]!;
    expect(call.url).toBe("https://example.test/v2/openOrders?symbol=BTC-USD");
    const h = authHeaders(call);
    expect(h["X-API-Wallet-Public-Key"]).toBe(PK);
    expect(h["X-API-Wallet-Timestamp"]).toBe("1788540000");
    expect(h["X-API-Wallet-Nonce"]).toBe(NONCE);
    expect(verifyRequestSignature({ headers: h, method: "GET", path: "/v2/openOrders?symbol=BTC-USD" })).toBe(
      true,
    );
    expect(verifyRequestSignature({ headers: h, method: "GET", path: "/v2/openOrders" })).toBe(false);
    expect(call.init.body).toBeUndefined();
  });

  it("POST serialises the body once and signs exactly the bytes sent", async () => {
    const { client, calls } = harness([json(createOrderAckFixture, 201)]);
    const ack = await client.createOrder({
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      size: 0.0123456,
      price: 78000.04,
      time_in_force: "GTC",
      post_only: true,
      client_order_id: "entry-001",
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://example.test/v2/order");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call)["Content-Type"]).toBe("application/json");
    const body = call.init.body as string;
    expect(JSON.parse(body)).toEqual({
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      size: "0.01234",
      price: "78000.0",
      time_in_force: "GTC",
      post_only: true,
      client_order_id: "entry-001",
    });
    expect(
      verifyRequestSignature({ headers: authHeaders(call), method: "POST", path: "/v2/order", body }),
    ).toBe(true);
    expect(ack).toEqual({
      clientOrderId: "entry-001",
      accountId: "01234567-89ab-cdef-0123-456789abcdef",
      symbol: "BTC-USD",
      sequenceId: 789012,
      messageId: "msg_xyz",
    });
  });

  it("DELETE cancel carries a signed JSON body", async () => {
    const { client, calls } = harness([
      json({ order_id: 123456, symbol: "BTC-USD", sequence_id: 1, message_id: "m" }),
    ]);
    const ack = await client.cancelOrder({ order_id: 123456, symbol: "BTC-USD" });
    const call = calls[0]!;
    expect(call.init.method).toBe("DELETE");
    expect(call.init.body).toBe('{"order_id":123456,"symbol":"BTC-USD"}');
    expect(
      verifyRequestSignature({
        headers: authHeaders(call),
        method: "DELETE",
        path: "/v2/order/cancel",
        body: call.init.body as string,
      }),
    ).toBe(true);
    expect(ack.orderId).toBe(123456);
  });

  it("cancelAll without symbol sends an empty object body", async () => {
    const { client, calls } = harness([json({ canceled_count: -1 })]);
    const ack = await client.cancelAll();
    expect(calls[0]!.init.body).toBe("{}");
    expect(ack.canceledCount).toBe(-1);
  });

  it("builds bracket (strategy) orders with tp/sl legs formatted to tick/step", async () => {
    const { client, calls } = harness([json(createStrategyAckFixture, 201)]);
    const ack = await client.createStrategyOrder({
      strategy_id: "s-001",
      client_order_id: "entry-001",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      size: 0.01,
      price: 78000,
      time_in_force: "GTC",
      tp_order: { type: "take_profit", size: 0.01, stop_price: 82000.06, working_type: "mark_price" },
      sl_order: { type: "stop", size: 0.01, stop_price: 76500, working_type: "mark_price" },
    });
    expect(calls[0]!.url).toBe("https://example.test/v2/order/strategy");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      strategy_id: "s-001",
      client_order_id: "entry-001",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      size: "0.01000",
      price: "78000.0",
      time_in_force: "GTC",
      tp_order: { type: "take_profit", size: "0.01000", stop_price: "82000.1", working_type: "mark_price" },
      sl_order: { type: "stop", size: "0.01000", stop_price: "76500.0", working_type: "mark_price" },
    });
    expect(ack).toMatchObject({ strategyId: "s-001", tpClientOrderId: "tp-001", slClientOrderId: "sl-001" });
  });

  it("replaceOrder nests cancel and new_order", async () => {
    const { client, calls } = harness([
      json({
        cancel: { order_id: 1, symbol: "BTC-USD" },
        new_order: createOrderAckFixture,
        sequence_id: 9,
        message_id: "m",
      }),
    ]);
    const ack = await client.replaceOrder({
      cancel: { order_id: 1, symbol: "BTC-USD" },
      new_order: {
        symbol: "BTC-USD",
        side: "sell",
        type: "stop",
        size: "0.01",
        stop_price: 77000,
        reduce_only: true,
      },
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      cancel: { order_id: 1, symbol: "BTC-USD" },
      new_order: {
        symbol: "BTC-USD",
        side: "sell",
        type: "stop",
        size: "0.01",
        stop_price: "77000.0",
        reduce_only: true,
      },
    });
    expect(ack.cancel?.orderId).toBe(1);
    expect(ack.newOrder?.clientOrderId).toBe("entry-001");
  });

  it("leverage and margin mode", async () => {
    const { client, calls } = harness([
      json({ leverage: 5, maxNotionalValue: "1000000", symbol: "BTC-USD" }),
      json({ marginMode: "isolated", symbol: "BTC-USD" }),
    ]);
    expect(await client.setLeverage("BTC-USD", 5)).toEqual({
      symbol: "BTC-USD",
      leverage: 5,
      maxNotionalValue: 1_000_000,
    });
    expect(await client.setMarginMode("BTC-USD", "isolated")).toEqual({
      symbol: "BTC-USD",
      marginMode: "isolated",
    });
    expect(calls[0]!.init.body).toBe('{"symbol":"BTC-USD","leverage":5}');
    expect(calls[1]!.init.body).toBe('{"symbol":"BTC-USD","marginMode":"isolated"}');
    expect(() => client.setLeverage("BTC-USD", 2.5)).toThrow(StrikeConfigError);
  });

  it("history queries map status names to the venue's integers and drop undefined params", async () => {
    const { client, calls } = harness([json(orderHistoryFixture), json(fillHistoryFixture)]);
    await client.orderHistory({ symbol: "BTC-USD", status: "filled", limit: 50 });
    expect(calls[0]!.url).toBe("https://example.test/v2/history/order?symbol=BTC-USD&status=3&limit=50");
    await client.fillHistory({ since_trade_id: 987654 });
    expect(calls[1]!.url).toBe("https://example.test/v2/history/fill?since_trade_id=987654");
    expect(() => client.fillHistory({ fromId: 1, since_trade_id: 2 })).toThrow(StrikeConfigError);
  });

  it("uses rules learned from exchangeInfo for other symbols", async () => {
    const { client, calls } = harness([json(exchangeInfoFixture), json(createOrderAckFixture, 201)]);
    await client.exchangeInfo();
    expect(client.cachedRules("XAU-USD")?.tickSize).toBe(0.01);
    await client.createOrder({
      symbol: "XAU-USD",
      side: "buy",
      type: "limit",
      size: 0.12345,
      price: 2345.678,
    });
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ size: "0.123", price: "2345.68" });
  });

  it("fetches exchangeInfo lazily for an unknown symbol", async () => {
    const { client, calls } = harness([json(exchangeInfoFixture), json(createOrderAckFixture, 201)]);
    await client.createOrder({ symbol: "XAU-USD", side: "sell", type: "market", size: 1 });
    expect(calls[0]!.url).toContain("/price/v2/exchangeInfo");
    expect(calls[1]!.url).toContain("/v2/order");
  });

  it("refuses authenticated calls without credentials", () => {
    const { client } = harness([], { auth: false });
    expect(() => client.account()).toThrow(StrikeConfigError);
    expect(client.hasCredentials).toBe(false);
  });

  it("getOrder requires an id", () => {
    const { client } = harness([]);
    expect(() => client.getOrder({ symbol: "BTC-USD" })).toThrow(StrikeConfigError);
  });
});

describe("serialisation helpers", () => {
  it("rejects malformed decimal strings and zero sizes", () => {
    expect(() =>
      serializeCreateOrder({ symbol: "BTC-USD", side: "buy", type: "limit", size: "1e-5" }, BTC_USD_RULES),
    ).toThrow(StrikeConfigError);
    expect(() =>
      serializeCreateOrder({ symbol: "BTC-USD", side: "buy", type: "limit", size: 0.000001 }, BTC_USD_RULES),
    ).toThrow(/rounds to zero/);
    expect(() =>
      serializeStrategyOrder(
        { strategy_id: "s", symbol: "BTC-USD", side: "buy", type: "limit", size: 1 },
        BTC_USD_RULES,
      ),
    ).toThrow(/tp_order/);
  });
  it("passes pre-formatted strings through untouched", () => {
    const out = serializeCreateOrder(
      { symbol: "BTC-USD", side: "buy", type: "limit", size: "0.5", price: "70000" },
      BTC_USD_RULES,
    );
    expect(out).toEqual({ symbol: "BTC-USD", side: "buy", type: "limit", size: "0.5", price: "70000" });
  });
});

describe("errors and retries", () => {
  it("maps 400 {code,msg} to StrikeApiError without retrying", async () => {
    const { client, calls } = harness(
      [json({ code: "MISSING_PARAMETER", msg: "interval parameter is required" }, 400)],
      { auth: false },
    );
    const err = await client.premiumIndex("BTC-USD").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrikeApiError);
    const e = err as StrikeApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("MISSING_PARAMETER");
    expect(e.message).toContain("interval parameter is required");
    expect(e.body).toEqual({ code: "MISSING_PARAMETER", msg: "interval parameter is required" });
    expect(e.isRetryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("maps 401 {error} and exposes the request id", async () => {
    const { client } = harness([json({ error: "authentication failed" }, 401, { "x-request-id": "req-1" })]);
    const err = (await client.account().catch((e: unknown) => e)) as StrikeApiError;
    expect(err.status).toBe(401);
    expect(err.isAuthError).toBe(true);
    expect(err.message).toContain("authentication failed");
    expect(err.requestId).toBe("req-1");
  });

  it("retries idempotent GETs on 5xx and network errors, then succeeds", async () => {
    const { client, calls } = harness(
      [json("upstream down", 503), new Error("socket hang up"), json(premiumIndexFixture)],
      { auth: false },
    );
    const pi = await client.premiumIndex("BTC-USD");
    expect(pi.markPrice).toBeCloseTo(79780.79, 2);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the configured attempts", async () => {
    const { client, calls } = harness([json("x", 500), json("x", 500), json("x", 500)], { auth: false });
    await expect(client.bookTicker("BTC-USD")).rejects.toBeInstanceOf(StrikeApiError);
    expect(calls).toHaveLength(3);
  });

  it("never retries order placement", async () => {
    const { client, calls } = harness([
      json({ error: "engine unavailable" }, 503),
      json(createOrderAckFixture, 201),
    ]);
    await expect(
      client.createOrder({ symbol: "BTC-USD", side: "buy", type: "market", size: 0.001 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("raises StrikeParseError on an unexpected 2xx shape", async () => {
    const { client, calls } = harness([json({ nope: true })], { auth: false });
    const err = await client.premiumIndex("BTC-USD").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrikeParseError);
    expect(calls).toHaveLength(1);
  });
});

describe("response parsing (recorded fixtures)", () => {
  it("exchangeInfo -> rules with tick/step/bounds", async () => {
    const { client } = harness([json(exchangeInfoFixture)], { auth: false });
    const info = await client.exchangeInfo();
    expect(info.rateLimits[0]).toEqual({
      rateLimitType: "REQUEST_WEIGHT",
      interval: "MINUTE",
      intervalNum: 1,
      limit: 2400,
    });
    const btc = info.symbols.find((s) => s.symbol === "BTC-USD")!;
    expect(btc.rules).toEqual(BTC_USD_RULES);
    expect(btc.limitTakeBound).toBe(0.05);
    expect(btc.orderTypes).toContain("LIMIT");
  });

  it("premiumIndex / markPrice", async () => {
    const { client } = harness([json(premiumIndexFixture), json(markPriceFixture)], { auth: false });
    const pi = await client.premiumIndex("BTC-USD");
    expect(pi).toMatchObject({
      symbol: "BTC-USD",
      fundingRate: 0.0000118475870710157,
      nextFundingTime: 1788541200000,
      interestRate: 0.0001,
    });
    const mp = await client.markPrice("BTC-USD");
    expect(mp).toEqual({
      eventTime: 1788540798020,
      symbol: "BTC-USD",
      markPrice: 79780.79063273,
      indexPrice: 79780.67910433,
      settlePrice: null,
      fundingRate: 0.0000118475870710157,
      nextFundingTime: 1788541200000,
    });
  });

  it("premiumIndex accepts the spec's lastFundingRate name", async () => {
    const specShape = { ...premiumIndexFixture, fundingRate: undefined, lastFundingRate: "0.0001" };
    const { client } = harness([json(specShape)], { auth: false });
    expect((await client.premiumIndex("BTC-USD")).fundingRate).toBe(0.0001);
  });

  it("klines -> Candle[] with venue strike", async () => {
    const { client } = harness([json(klinesFixture), json(klinesFixture)], { auth: false });
    const candles = await client.klines({ symbol: "BTC-USD", interval: "1h", priceType: "index", limit: 3 });
    expect(candles).toHaveLength(3);
    expect(candles[0]).toEqual({
      venue: "strike",
      symbol: "BTC-USD",
      interval: "1h",
      openTime: 1788526800000,
      closeTime: 1788530399999,
      open: 79482.1,
      high: 79689.1,
      low: 78987.8,
      close: 79368.1,
      volume: 1.76195,
    });
    const raw = await client.klinesRaw({ symbol: "BTC-USD", interval: "1h" });
    expect(raw[0]).toMatchObject({ quoteVolume: 139961.58385, trades: 316, takerBuyBase: 0.73411 });
  });

  it("depth keeps the uint64 lastUpdateId as bigint and parses levels", async () => {
    const { client, calls } = harness([json(depthFixtureText)], { auth: false });
    const d = await client.depth("BTC-USD", 6);
    expect(calls[0]!.url).toBe("https://example.test/price/v2/depth?symbol=BTC-USD&limit=6");
    expect(d.lastUpdateId).toBe(18446744073709551615n);
    expect(d.eventTime).toBe(1788540799931);
    expect(d.bids[0]).toEqual({ price: 79765.7, qty: 0.03007 });
    expect(d.asks[0]).toEqual({ price: 79769.5, qty: 0.12536 });
  });

  it("bookTicker / openInterest / feeTiers / market", async () => {
    const { client } = harness(
      [json(bookTickerFixture), json(openInterestFixture), json(feeTiersFixture), json(marketFixture)],
      { auth: false },
    );
    expect(await client.bookTicker("BTC-USD")).toEqual({
      symbol: "BTC-USD",
      bidPrice: 79808.8,
      bidQty: 0.00626,
      askPrice: 79810.4,
      askQty: 0.00136,
      time: 1788540802016,
    });
    expect(await client.openInterest("BTC-USD")).toEqual({
      symbol: "BTC-USD",
      openInterest: 4.37466,
      time: 1788540803226,
    });
    const fees = await client.feeTiers();
    expect(fees.feeTiers[0]).toEqual({ tier: 0, minVolume: 0, takerRate: 0.0005, makerRate: -0.00005 });
    expect(fees.makerRebateTiers[0]?.makerRate).toBe(-0.00008);
    const m = await client.market("BTC-USD");
    expect(m).toMatchObject({
      symbol: "BTC-USD",
      defaultLeverage: 10,
      limitTakeBound: 0.05,
      marketTakeBound: 0.05,
      tickSize: 0.1,
      stepSize: 0.00001,
      maxMarketSize: 120,
      minNotional: 10,
      liquidationFeeRate: 0.0125,
      markPrice: 79762.34563747,
      bestBid: 79808.8,
      impactNotional: 2500,
    });
    expect(m.marginTiers).toHaveLength(14);
    expect(m.marginTiers[5]).toEqual({
      maxNotional: 800_000,
      maxLeverage: 25,
      maintenanceMarginRate: 0.005,
      maintenanceAmount: 300,
    });
    expect(m.rules.priceDecimals).toBe(1);
    expect(m.rules.sizeDecimals).toBe(5);
  });

  it("account / balances / positions", async () => {
    const { client } = harness([
      json(accountFixture),
      json(balancesFixture),
      json(positionsFixture),
      json(positionsPascalFixture),
    ]);
    const acct = await client.account();
    expect(acct).toMatchObject({
      accountId: "019d1935-5bba-726e-a38e-838a892245f3",
      walletBalance: 10000,
      availableBalance: 7500,
      unrealizedPnl: 250.5,
      marginBalance: 10250.5,
      maintenanceMargin: 500,
    });
    expect(acct.symbolSettings["BTC-USD"]).toEqual({
      marginMode: "isolated",
      leverage: 5,
      allowPreTrade: false,
    });
    const bal = await client.balances();
    expect(bal[0]).toMatchObject({
      asset: "USDT",
      walletBalance: 10000,
      availableBalance: 7500,
      marginAvailable: true,
    });
    const pos = await client.positions();
    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({
      symbol: "BTC-USD",
      direction: "long",
      size: 0.5,
      entryPrice: 50000,
      leverage: 5,
      isoBalance: 5000,
      liquidationPrice: 45500,
      unrealizedPnl: 250.5,
    });
    expect(pos[1]).toMatchObject({
      symbol: "ETH-USD",
      direction: "short",
      size: -2,
      liquidationPrice: null,
      bankruptcyPrice: null,
    });
    const pascal = await client.positions("BTC-USD");
    expect(pascal[0]).toMatchObject({
      id: 7,
      direction: "short",
      size: -0.25,
      entryPrice: 81000,
      leverage: 3,
      isoBalance: 6750,
      liquidationPrice: 106500,
    });
  });

  it("openOrders (PascalCase) and getOrder", async () => {
    const { client, calls } = harness([json(openOrdersFixture), json(openOrdersFixture.orders[0])]);
    const orders = await client.openOrders();
    expect(calls[0]!.url).toBe("https://example.test/v2/openOrders");
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      id: 123456,
      clientOrderId: "entry-001",
      symbol: "BTC-USD",
      side: "buy",
      status: "open",
      type: "limit",
      originType: null,
      timeInForce: "GTC",
      workingType: "none",
      size: 0.01,
      filled: 0,
      price: 78000,
      postOnly: true,
      strategy: { id: "s-001", isPrimary: true },
      trailing: null,
    });
    expect(orders[1]).toMatchObject({
      status: "untriggered",
      type: "stop",
      stopPrice: 76500,
      reduceOnly: true,
      workingType: "mark_price",
      strategy: { id: "s-001", isPrimary: false },
    });
    const one = await client.getOrder({ symbol: "BTC-USD", client_order_id: "entry-001" });
    expect(calls[1]!.url).toBe("https://example.test/v2/order?symbol=BTC-USD&client_order_id=entry-001");
    expect(one.id).toBe(123456);
  });

  it("orderHistory / fillHistory / fundingHistory / closedPositions", async () => {
    const { client } = harness([
      json(orderHistoryFixture),
      json(fillHistoryFixture),
      json(fundingHistoryFixture),
      json(closedPositionsFixture),
    ]);
    const orders = await client.orderHistory();
    expect(orders[0]).toMatchObject({
      id: 123456,
      status: "filled",
      size: 0.1,
      filled: 0.1,
      price: 50000,
      originType: null,
      workingType: null,
      strategyId: null,
    });
    const fills = await client.fillHistory();
    expect(fills[0]).toMatchObject({
      tradeId: 987654,
      orderId: 123456,
      role: "maker",
      price: 50000,
      size: 0.1,
      fee: -0.25,
      leverage: 5,
      timestamp: 1709000001000,
    });
    const funding = await client.fundingHistory();
    expect(funding[0]).toMatchObject({
      symbol: "BTC-USD",
      positionSide: "Long",
      fundingRate: 0.0001,
      amount: -1.25,
      timestamp: 1709003600000,
    });
    const closed = await client.closedPositions({ symbol: "BTC-USD" });
    expect(closed[0]).toMatchObject({
      id: 1,
      symbol: "BTC-USD",
      marginMode: "isolated",
      openTimestamp: 1709000000000,
      closeTimestamp: 1709086400000,
      side: null,
    });
    expect(closed[1]).toMatchObject({
      id: 2,
      side: "long",
      size: 0.5,
      entryPrice: 50000,
      exitPrice: 52000,
      realizedPnl: 1000,
      leverage: 10,
      openTimestamp: 1699900000000,
      closeTimestamp: 1700000000000,
    });
  });
});
