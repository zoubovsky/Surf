import { readFileSync } from "node:fs";
import type { Candle, Interval } from "@surf/core";
import { INTERVAL_MS } from "@surf/core";
import type { FetchLike } from "../types.js";

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type FakeFetch = FetchLike & { calls: URL[] };

/** Build a fetch double. Handler may return a Response, or any value to be sent as JSON 200. */
export function fakeFetch(handler: (url: URL, init?: RequestInit) => unknown): FakeFetch {
  const calls: URL[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const out = await handler(url, init);
    return out instanceof Response ? out : jsonResponse(out);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

export const HOUR = INTERVAL_MS["1h"];

/** Deterministic synthetic price path. */
export function priceAt(t: number, base = 80_000): number {
  return base + 500 * Math.sin(t / HOUR / 7) + 50 * Math.cos(t / HOUR);
}

export function candle(openTime: number, over: Partial<Candle> = {}): Candle {
  const interval: Interval = over.interval ?? "1h";
  const o = priceAt(openTime);
  const c = priceAt(openTime + INTERVAL_MS[interval]);
  return {
    venue: "test",
    symbol: "BTC-USD",
    interval,
    openTime,
    closeTime: openTime + INTERVAL_MS[interval] - 1,
    open: o,
    high: Math.max(o, c) + 10,
    low: Math.min(o, c) - 10,
    close: c,
    volume: 1,
    ...over,
  };
}

/** Consecutive 1h candles starting at `start`. */
export function candles(start: number, n: number, over: Partial<Candle> = {}): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(start + i * HOUR, over));
}

/** Strike/Binance 12-element row for a synthetic candle (string prices). */
export function klineRow(openTime: number, scale = 1): unknown[] {
  const c = candle(openTime);
  const s = (x: number) => (x * scale).toFixed(8);
  return [openTime, s(c.open), s(c.high), s(c.low), s(c.close), "1.5", openTime + HOUR - 1, "120000", 42, "0.7", "56000", "0"];
}

/** Coinbase 6-element row [time_s, low, high, open, close, volume]. */
export function coinbaseRow(openTime: number, scale = 1): number[] {
  const c = candle(openTime);
  return [openTime / 1000, c.low * scale, c.high * scale, c.open * scale, c.close * scale, 12.5];
}
