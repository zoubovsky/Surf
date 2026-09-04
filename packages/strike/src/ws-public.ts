/**
 * Public market-data stream (`wss://api.strikefinance.org/ws/price`). No authentication.
 *
 * Channels used: `markprice` (every 3s: mark, index, funding, next funding time) and
 * `kline_{interval}` (emitted on trades; `closed` flag from `k.x`). Both channel spellings
 * (`markprice`/`markPrice`) and symbol cases were accepted live; we send lowercase symbols.
 */
import { z } from "zod";
import { KlineInterval, KLINE_INTERVAL_MS, MarkPriceUpdateSchema, dec, int } from "./schemas.js";
import type { MarkPriceUpdate } from "./schemas.js";
import { ReconnectingSocket, type BaseEvents, type ReconnectingSocketOptions } from "./ws-base.js";

export const STRIKE_PUBLIC_WS_MAINNET = "wss://api.strikefinance.org/ws/price";
export const STRIKE_PUBLIC_WS_TESTNET = "wss://api-v2-testnet.strikefinance.org/ws/price";

export interface KlineEvent {
  eventTime: number;
  symbol: string;
  interval: KlineInterval;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  trades: number | null;
  /** True once the bar is final. */
  closed: boolean;
}

const KlineEventSchema = z.looseObject({
  e: z.literal("kline"),
  E: int.optional(),
  s: z.string().optional(),
  k: z.looseObject({
    t: int,
    T: int.optional(),
    s: z.string().optional(),
    i: KlineInterval,
    o: dec,
    h: dec,
    l: dec,
    c: dec,
    v: dec,
    q: dec.optional(),
    n: int.optional(),
    x: z.boolean().optional(),
  }),
});

export function parseKlineEvent(value: unknown, now: number): KlineEvent | null {
  const r = KlineEventSchema.safeParse(value);
  if (!r.success) return null;
  const { k } = r.data;
  const closeTime = k.T ?? k.t + KLINE_INTERVAL_MS[k.i] - 1;
  return {
    eventTime: r.data.E ?? now,
    symbol: k.s ?? r.data.s ?? "",
    interval: k.i,
    openTime: k.t,
    closeTime,
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    volume: k.v,
    quoteVolume: k.q ?? null,
    trades: k.n ?? null,
    closed: k.x ?? now > closeTime,
  };
}

export interface SubscriptionAck {
  id: number | string;
  result: unknown;
  error: unknown;
}

export interface PublicStreamEvents extends BaseEvents {
  markPrice: MarkPriceUpdate;
  kline: KlineEvent;
  /** Reply to a subscribe/unsubscribe/ping request. */
  ack: SubscriptionAck;
}

export interface StrikePublicStreamOptions extends Partial<Omit<ReconnectingSocketOptions, "url">> {
  url?: string | undefined;
  now?: (() => number) | undefined;
}

type Channel = { channel: string; symbol: string | undefined };

export class StrikePublicStream extends ReconnectingSocket<PublicStreamEvents> {
  private readonly subs = new Map<string, Channel>();
  private readonly now: () => number;

  constructor(opts: StrikePublicStreamOptions = {}) {
    super({ ...opts, url: opts.url ?? STRIKE_PUBLIC_WS_MAINNET });
    this.now = opts.now ?? Date.now;
  }

  /** Current subscription keys (channel:symbol). */
  get subscriptions(): string[] {
    return [...this.subs.keys()];
  }

  subscribeMarkPrice(symbol: string): void {
    this.subscribe("markprice", symbol);
  }

  unsubscribeMarkPrice(symbol: string): void {
    this.unsubscribe("markprice", symbol);
  }

  subscribeKline(symbol: string, interval: KlineInterval): void {
    this.subscribe(`kline_${interval}`, symbol);
  }

  unsubscribeKline(symbol: string, interval: KlineInterval): void {
    this.unsubscribe(`kline_${interval}`, symbol);
  }

  /** Generic subscribe (e.g. "depth", "trade", "!markprice@arr"). Replayed after reconnects. */
  subscribe(channel: string, symbol?: string): void {
    const sub: Channel = { channel, symbol: symbol?.toLowerCase() };
    const key = keyOf(sub);
    if (this.subs.has(key)) return;
    this.subs.set(key, sub);
    if (this.isOpen) this.sendSubscribe(sub, "subscribe");
  }

  unsubscribe(channel: string, symbol?: string): void {
    const sub: Channel = { channel, symbol: symbol?.toLowerCase() };
    const key = keyOf(sub);
    if (!this.subs.delete(key)) return;
    if (this.isOpen) this.sendSubscribe(sub, "unsubscribe");
  }

  protected onOpen(): void {
    for (const sub of this.subs.values()) this.sendSubscribe(sub, "subscribe");
  }

  protected onMessage(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const v = value as Record<string, unknown>;
    if ("id" in v && !("e" in v)) {
      this.emit("ack", {
        id: v["id"] as number | string,
        result: v["result"],
        error: v["error"] ?? v["msg"],
      });
      return;
    }
    switch (v["e"]) {
      case "markPriceUpdate": {
        const r = MarkPriceUpdateSchema.safeParse(v);
        if (r.success) this.emit("markPrice", r.data);
        else this.logger?.warn({ issues: r.error.issues }, "strike ws: bad markPriceUpdate");
        return;
      }
      case "kline": {
        const ev = parseKlineEvent(v, this.now());
        if (ev) this.emit("kline", ev);
        else this.logger?.warn({ v }, "strike ws: bad kline event");
        return;
      }
      default:
        return;
    }
  }

  private sendSubscribe(sub: Channel, method: "subscribe" | "unsubscribe"): void {
    const msg: Record<string, unknown> = { id: this.allocId(), method, channel: sub.channel };
    if (sub.symbol) msg["symbol"] = sub.symbol;
    this.send(msg);
  }
}

function keyOf(c: Channel): string {
  return c.symbol ? `${c.channel}:${c.symbol}` : c.channel;
}
