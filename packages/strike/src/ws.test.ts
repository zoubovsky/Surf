import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyLogonSignature, type LogonMessage } from "./auth.js";
import { parseFrame, type WebSocketLike } from "./ws-base.js";
import { StrikePublicStream, parseKlineEvent } from "./ws-public.js";
import { StrikeUserStream, parseAccountUpdate, parseOrderTradeUpdate } from "./ws-user.js";

const SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

type Handler = (...args: unknown[]) => void;

class FakeWs implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Handler[]>();
  constructor(readonly url: string) {}
  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.fire("close", 1006, "");
  }
  // test drivers
  open(): void {
    this.readyState = 1;
    this.fire("open");
  }
  message(text: string): void {
    this.fire("message", Buffer.from(text), false);
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.fire("close", code, Buffer.from(reason));
  }
  ping(): void {
    this.fire("ping");
  }
  private fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  sentJson(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function fakeFactory() {
  const sockets: FakeWs[] = [];
  const factory = (url: string): WebSocketLike => {
    const s = new FakeWs(url);
    sockets.push(s);
    return s;
  };
  return { sockets, factory, last: () => sockets[sockets.length - 1]! };
}

describe("parseFrame", () => {
  it("splits newline-delimited events and flattens arrays", () => {
    const frame =
      '{"id":1,"result":null}\n{"e":"markPriceUpdate","s":"BTC-USD"}\n\n[{"e":"24hrMiniTicker","s":"BTC-USD"},{"e":"24hrMiniTicker","s":"ETH-USD"}]\n';
    const values = parseFrame(frame);
    expect(values).toHaveLength(4);
    expect(values[1]).toEqual({ e: "markPriceUpdate", s: "BTC-USD" });
    expect(values[3]).toEqual({ e: "24hrMiniTicker", s: "ETH-USD" });
  });
  it("accepts Buffers", () => {
    expect(parseFrame(Buffer.from('{"a":1}\n{"b":2}'))).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("throws on malformed JSON", () => {
    expect(() => parseFrame("{oops")).toThrow();
  });
});

describe("StrikePublicStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes on open with lowercase symbols and routes typed events", () => {
    const { factory, last } = fakeFactory();
    const stream = new StrikePublicStream({ webSocketFactory: factory, now: () => 1_788_540_000_000 });
    const marks: unknown[] = [];
    const klines: unknown[] = [];
    const acks: unknown[] = [];
    stream.on("markPrice", (m) => marks.push(m));
    stream.on("kline", (k) => klines.push(k));
    stream.on("ack", (a) => acks.push(a));
    stream.subscribeMarkPrice("BTC-USD");
    stream.subscribeKline("BTC-USD", "1h");
    stream.connect();
    const ws = last();
    expect(ws.url).toBe("wss://api.strikefinance.org/ws/price");
    expect(ws.sent).toHaveLength(0);
    ws.open();
    expect(ws.sentJson()).toEqual([
      { id: 1, method: "subscribe", channel: "markprice", symbol: "btc-usd" },
      { id: 2, method: "subscribe", channel: "kline_1h", symbol: "btc-usd" },
    ]);
    // Multi-event frame exactly as observed live.
    ws.message(
      '{"id":1,"result":null}\n{"e":"markPriceUpdate","E":1788540995338,"s":"BTC-USD","p":"79804.29324831","i":"79805.33230130","r":"0.0000118180663068339","T":1788541200000}',
    );
    expect(acks).toEqual([{ id: 1, result: null, error: undefined }]);
    expect(marks).toEqual([
      {
        eventTime: 1788540995338,
        symbol: "BTC-USD",
        markPrice: 79804.29324831,
        indexPrice: 79805.3323013,
        settlePrice: null,
        fundingRate: 0.0000118180663068339,
        nextFundingTime: 1788541200000,
      },
    ]);
    ws.message(
      '{"e":"kline","E":1788540000500,"s":"BTC-USD","k":{"t":1788537600000,"T":1788541199999,"s":"BTC-USD","i":"1h","o":"79414.1","h":"79900","l":"79300","c":"79800","v":"3.5","n":120,"q":"278000","x":false}}',
    );
    expect(klines[0]).toMatchObject({
      symbol: "BTC-USD",
      interval: "1h",
      openTime: 1788537600000,
      closeTime: 1788541199999,
      close: 79800,
      volume: 3.5,
      trades: 120,
      closed: false,
    });
    // Skill-shaped kline without T/x: closeTime derived, closed inferred from now.
    const ev = parseKlineEvent(
      {
        e: "kline",
        k: { s: "BTCUSD", i: "1h", t: 1788530400000, o: "1", h: "2", l: "0.5", c: "1.5", v: "0" },
      },
      1788540000000,
    );
    expect(ev).toMatchObject({ closeTime: 1788533999999, closed: true, symbol: "BTCUSD" });
  });

  it("reconnects with exponential backoff, replays subscriptions and resets the attempt counter", () => {
    const { factory, sockets, last } = fakeFactory();
    const stream = new StrikePublicStream({
      webSocketFactory: factory,
      backoff: { baseMs: 1000, maxMs: 30_000, jitter: 0 },
      random: () => 0,
    });
    const reconnects: { attempt: number; delayMs: number }[] = [];
    stream.on("reconnecting", (r) => reconnects.push(r));
    stream.subscribeMarkPrice("BTC-USD");
    stream.connect();
    last().open();
    last().serverClose(1006);
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 1000 }]);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    // Fails again before opening: delay doubles.
    last().serverClose(1006);
    expect(reconnects[1]).toEqual({ attempt: 2, delayMs: 2000 });
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(3);
    last().serverClose(1006);
    expect(reconnects[2]).toEqual({ attempt: 3, delayMs: 4000 });
    vi.advanceTimersByTime(4000);
    last().open();
    expect(last().sentJson()).toEqual([
      { id: expect.any(Number), method: "subscribe", channel: "markprice", symbol: "btc-usd" },
    ]);
    expect(stream.reconnectAttempts).toBe(0);
    expect(stream.isOpen).toBe(true);
    // Next failure starts from the base delay again.
    last().serverClose(1006);
    expect(reconnects[3]).toEqual({ attempt: 1, delayMs: 1000 });
  });

  it("caps the delay at maxMs and gives up after maxAttempts", () => {
    const { factory, last } = fakeFactory();
    const stream = new StrikePublicStream({
      webSocketFactory: factory,
      backoff: { baseMs: 1000, maxMs: 2500, maxAttempts: 3, jitter: 0 },
    });
    const delays: number[] = [];
    const giveUps: unknown[] = [];
    stream.on("reconnecting", (r) => delays.push(r.delayMs));
    stream.on("giveUp", (g) => giveUps.push(g));
    stream.connect();
    for (let i = 0; i < 3; i++) {
      last().serverClose(1006);
      vi.runOnlyPendingTimers();
    }
    expect(delays).toEqual([1000, 2000, 2500]);
    last().serverClose(1006);
    expect(giveUps).toHaveLength(1);
    expect(stream.state).toBe("closed");
  });

  it("close() stops reconnecting and unsubscribe sends unsubscribe while open", () => {
    const { factory, sockets, last } = fakeFactory();
    const stream = new StrikePublicStream({ webSocketFactory: factory, backoff: { baseMs: 10, jitter: 0 } });
    stream.subscribeMarkPrice("BTC-USD");
    stream.connect();
    last().open();
    stream.unsubscribeMarkPrice("BTC-USD");
    expect(last().sentJson()[1]).toMatchObject({
      method: "unsubscribe",
      channel: "markprice",
      symbol: "btc-usd",
    });
    stream.close();
    expect(last().closeCalls).toEqual([{ code: 1000, reason: "client close" }]);
    last().serverClose(1000);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(stream.subscriptions).toEqual([]);
  });

  it("terminates an idle connection and reconnects; pings reset the watchdog", () => {
    const { factory, sockets, last } = fakeFactory();
    const stream = new StrikePublicStream({
      webSocketFactory: factory,
      idleTimeoutMs: 1000,
      backoff: { baseMs: 10, jitter: 0 },
    });
    stream.connect();
    last().open();
    vi.advanceTimersByTime(900);
    last().ping();
    vi.advanceTimersByTime(900);
    expect(last().terminated).toBe(false);
    vi.advanceTimersByTime(100);
    expect(sockets[0]!.terminated).toBe(true);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
  });

  it("isolates listener errors", () => {
    const { factory, last } = fakeFactory();
    const stream = new StrikePublicStream({ webSocketFactory: factory });
    const seen: unknown[] = [];
    stream.on("ack", () => {
      throw new Error("boom");
    });
    stream.on("ack", (a) => seen.push(a));
    stream.connect();
    last().open();
    last().message('{"id":5,"method":"pong"}');
    expect(seen).toHaveLength(1);
  });
});

describe("StrikeUserStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const NOW = 1_705_000_000_000;

  function connected() {
    const { factory, sockets, last } = fakeFactory();
    const stream = new StrikeUserStream({
      webSocketFactory: factory,
      privateKey: SK,
      now: () => NOW,
      backoff: { baseMs: 10, jitter: 0 },
    });
    const events: Record<string, unknown[]> = {
      authenticated: [],
      subscribed: [],
      authError: [],
      orderUpdate: [],
      accountUpdate: [],
      strategyUpdate: [],
      giveUp: [],
    };
    for (const k of Object.keys(events)) stream.on(k as "authenticated", (e) => events[k]!.push(e));
    stream.connect();
    last().open();
    return { stream, sockets, last, events };
  }

  it("logs on with a verifiable signature, then subscribes with the returned account_id", () => {
    const { stream, last, events } = connected();
    const ws = last();
    expect(ws.url).toBe("wss://api.strikefinance.org/ws/user-api");
    const logon = ws.sentJson()[0] as unknown as LogonMessage;
    expect(logon).toMatchObject({ method: "session.logon", params: { apiKey: PK, timestamp: NOW }, id: 1 });
    expect(verifyLogonSignature(logon)).toBe(true);
    expect(stream.authenticated).toBe(false);
    ws.message('{"id":1,"status":200,"result":{"authenticated":true,"account_id":"acc-123"}}');
    expect(events["authenticated"]).toEqual([{ accountId: "acc-123" }]);
    expect(ws.sentJson()[1]).toEqual({
      method: "subscribe",
      channel: "userstream",
      account_id: "acc-123",
      id: 2,
    });
    expect(stream.authenticated).toBe(true);
    expect(stream.subscribed).toBe(false);
    ws.message('{"id":2,"result":null}');
    expect(events["subscribed"]).toEqual([{ accountId: "acc-123" }]);
    expect(stream.subscribed).toBe(true);
    expect(stream.accountId).toBe("acc-123");
  });

  it("emits authError when the logon is rejected", () => {
    const { last, events } = connected();
    last().message(
      '{"id":1,"status":401,"error":{"code":-1022,"msg":"Signature for this request is not valid."}}',
    );
    expect(events["authError"]).toEqual([
      { status: 401, message: "Signature for this request is not valid." },
    ]);
    expect(last().sentJson()).toHaveLength(1);
  });

  it("routes ORDER_TRADE_UPDATE, ACCOUNT_UPDATE and strategyUpdate", () => {
    const { last, events } = connected();
    const ws = last();
    ws.message(
      '{"id":1,"status":200,"result":{"authenticated":true,"account_id":"acc"}}\n{"id":2,"result":null}',
    );
    ws.message(
      JSON.stringify({
        e: "ORDER_TRADE_UPDATE",
        E: 1234567890000,
        data: {
          s: "BTC-USD",
          c: "my-order-001",
          S: "BUY",
          o: "LIMIT",
          f: "GTC",
          q: "0.5",
          p: "45000.00",
          X: "FILLED",
          x: "TRADE",
          i: 12345,
          z: "0.5",
          l: "0.5",
          L: "45000.00",
          n: "0.0005",
          N: "USD",
          t: 99999,
          m: false,
          R: false,
          sp: "0",
          wt: "MARK_PRICE",
          cp: false,
          AP: "67000",
          CR: "5",
          rp: "0",
          T: 1234567890000,
          E: 1234567890000,
        },
      }) +
        "\n" +
        JSON.stringify({
          e: "ACCOUNT_UPDATE",
          E: 1234567890000,
          data: {
            e: "ORDER",
            B: [{ a: "USDT", wb: "10000.00", cw: "9500.00", bc: "500.00" }],
            P: [
              { s: "BTC-USD", pa: "-1.5", ep: "42000.00", mt: "isolated", ib: "1000", ps: "SHORT", i: 12345 },
            ],
            r: "FILL",
            E: 1234567890000,
            T: 1234567890000,
          },
        }) +
        "\n" +
        JSON.stringify({
          e: "strategyUpdate",
          E: 1705000000000,
          s: "BTC-USD",
          data: {
            account_id: "acc",
            strategy_id: "s-001",
            market: "BTC-USD",
            status: "completed",
            side: "BUY",
            filled_size: "0.01",
            total_size: "0.01",
            last_error: "",
            completed_at_ms: 1705000000000,
          },
        }),
    );
    expect(events["orderUpdate"]).toHaveLength(1);
    expect(events["orderUpdate"][0]).toMatchObject({
      symbol: "BTC-USD",
      clientOrderId: "my-order-001",
      orderId: 12345,
      side: "BUY",
      orderType: "LIMIT",
      status: "FILLED",
      executionType: "TRADE",
      originalQty: 0.5,
      cumulativeFilledQty: 0.5,
      lastFilledQty: 0.5,
      lastFilledPrice: 45000,
      commission: 0.0005,
      commissionAsset: "USD",
      tradeId: 99999,
      isMaker: false,
      workingType: "MARK_PRICE",
      activationPrice: 67000,
      callbackRate: 5,
      isFill: true,
      isFinal: true,
    });
    expect(events["accountUpdate"][0]).toEqual({
      eventTime: 1234567890000,
      transactionTime: 1234567890000,
      reason: "FILL",
      balances: [{ asset: "USDT", walletBalance: 10000, crossWalletBalance: 9500, balanceChange: 500 }],
      positions: [
        {
          symbol: "BTC-USD",
          positionAmount: -1.5,
          entryPrice: 42000,
          marginType: "isolated",
          isolatedBalance: 1000,
          positionSide: "SHORT",
          positionId: "12345",
        },
      ],
      eventType: null,
      eventData: undefined,
    });
    expect(events["strategyUpdate"][0]).toMatchObject({
      strategyId: "s-001",
      market: "BTC-USD",
      status: "completed",
      filledSize: 0.01,
      totalSize: 0.01,
      lastError: null,
      completedAt: 1705000000000,
    });
  });

  it("distinguishes status echoes from real fills", () => {
    const echo = parseOrderTradeUpdate(
      { s: "BTC-USD", i: 1, S: "SELL", o: "STOP", q: "0.1", X: "NEW", x: "NEW", t: 0 },
      1,
    )!;
    expect(echo.isFill).toBe(false);
    expect(echo.isFinal).toBe(false);
    const partial = parseOrderTradeUpdate(
      {
        s: "BTC-USD",
        i: 1,
        S: "SELL",
        o: "LIMIT",
        q: "0.1",
        X: "PARTIALLY_FILLED",
        x: "TRADE",
        t: 5,
        l: "0.05",
        L: "80000",
        z: "0.05",
        n: "0.02",
        N: "USDT",
      },
      1,
    )!;
    expect(partial.isFill).toBe(true);
    expect(partial.isFinal).toBe(false);
    const vault = parseAccountUpdate({ event_type: "vault_deposit", event_data: { x: 1 } }, 7)!;
    expect(vault.eventType).toBe("vault_deposit");
    expect(vault.balances).toEqual([]);
  });

  it("stops reconnecting on auth close codes", () => {
    const { stream, sockets, last, events } = connected();
    last().serverClose(4401, "unauthorized");
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(events["giveUp"]).toEqual([{ code: 4401, reason: "unauthorized" }]);
    expect(stream.state).toBe("closed");
  });

  it("re-logs on after a transient disconnect", () => {
    const { stream, sockets, last } = connected();
    last().message('{"id":1,"status":200,"result":{"authenticated":true,"account_id":"acc"}}');
    last().serverClose(1006);
    expect(stream.authenticated).toBe(false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    last().open();
    const logon = last().sentJson()[0]!;
    expect(logon["method"]).toBe("session.logon");
    expect(logon["id"]).toBe(3);
    last().message('{"id":3,"status":200,"result":{"authenticated":true,"account_id":"acc"}}');
    expect(last().sentJson()[1]).toMatchObject({ method: "subscribe", account_id: "acc", id: 4 });
  });
});
