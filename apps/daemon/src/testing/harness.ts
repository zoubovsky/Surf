/**
 * In-memory test harness: builds the whole daemon with a fake HTTP world (Strike public API,
 * Coinbase, YouTube feed), a fake Telegram API, a fake transcript provider and an injected clock.
 * Not part of the tsc build (see tsconfig `exclude`); vitest imports it directly.
 */
import { readFileSync } from "node:fs";
import {
  AppConfig,
  RiskLimits,
  createLogger,
  type Candle,
  type EwAnalysis,
  type EwCandidate,
} from "@surf/core";
import type { LlmClient } from "@surf/agents";
import type { Transcript, TranscriptProvider } from "@surf/ingestion";
import type { NotifierApi } from "@surf/telegram";
import { exchangeInfoFixture } from "../../../../packages/strike/src/fixtures/index.js";
import { buildApp, type App, type AppDeps } from "../app.js";
import { openDb, type Db } from "../db/index.js";
import type { EwAnalyzer } from "../context.js";

export const H = 3_600_000;
/** 2026-09-04T01:03:20Z, one hour after the premiumIndex fixture. */
export const T0 = 1_788_541_400_000;
export const STRIKE = "https://strike.test";
export const VIDEO_ID = "3wXfppSKkpg";

export interface Scenario {
  now: number;
  mark: number;
  index: number;
  fundingRate: number;
  coinbasePrice: number | null;
  /** Hourly candles (ascending), the last one may be in progress. Served to both venues. */
  candles: Candle[];
  feedXml: string | null;
  /** Request log: `${method} ${pathname}` */
  requests: string[];
  failStrike: boolean;
}

export function synthCandles(endOpenTime: number, n: number, base = 79_700): Candle[] {
  const out: Candle[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const openTime = endOpenTime - i * H;
    const k = (endOpenTime - openTime) / H;
    const o = base + 300 * Math.sin(k / 9) + 40 * Math.cos(k / 3);
    const c = base + 300 * Math.sin((k - 1) / 9) + 40 * Math.cos((k - 1) / 3);
    out.push({
      venue: "strike",
      symbol: "BTC-USD",
      interval: "1h",
      openTime,
      closeTime: openTime + H - 1,
      open: o,
      high: Math.max(o, c) + 60,
      low: Math.min(o, c) - 60,
      close: c,
      volume: 12,
    });
  }
  return out;
}

export function makeScenario(over: Partial<Scenario> = {}): Scenario {
  const now = over.now ?? T0;
  return {
    now,
    mark: 79_780,
    index: 79_775,
    fundingRate: 0.0000118,
    coinbasePrice: 79_790,
    candles: synthCandles(Math.floor(now / H) * H, 800),
    feedXml: readFileSync(
      new URL("../../../../packages/ingestion/src/__fixtures__/uulf-feed.xml", import.meta.url),
      "utf8",
    ),
    requests: [],
    failStrike: false,
    ...over,
  };
}

/** Mutate the in-progress candle's range (and append a fresh bar when the clock crossed an hour). */
export function touchLastCandle(s: Scenario, patch: { low?: number; high?: number; close?: number }): void {
  const bucket = Math.floor(s.now / H) * H;
  let last = s.candles[s.candles.length - 1]!;
  while (last.openTime < bucket) {
    const openTime = last.openTime + H;
    const next: Candle = {
      ...last,
      openTime,
      closeTime: openTime + H - 1,
      open: last.close,
      high: last.close + 20,
      low: last.close - 20,
      close: last.close,
    };
    s.candles.push(next);
    last = next;
  }
  if (patch.low !== undefined) last.low = Math.min(patch.low, last.low);
  if (patch.high !== undefined) last.high = Math.max(patch.high, last.high);
  if (patch.close !== undefined) last.close = patch.close;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function klineRow(c: Candle): unknown[] {
  return [
    c.openTime,
    String(c.open),
    String(c.high),
    String(c.low),
    String(c.close),
    String(c.volume),
    c.closeTime,
    "0",
    1,
    "0",
    "0",
    "0",
  ];
}

export function fakeFetch(s: Scenario): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    s.requests.push(`${method} ${url.pathname}`);
    const q = url.searchParams;
    if (url.origin === STRIKE) {
      if (s.failStrike) return json({ msg: "down" }, 503);
      switch (url.pathname) {
        case "/v2/ping":
          return json({});
        case "/price/v2/exchangeInfo":
          return json(exchangeInfoFixture);
        case "/price/v2/premiumIndex":
          return json({
            symbol: "BTC-USD",
            markPrice: String(s.mark),
            indexPrice: String(s.index),
            fundingRate: String(s.fundingRate),
            nextFundingTime: Math.floor(s.now / H) * H + H,
            interestRate: "0.0001",
            time: s.now,
          });
        case "/price/v2/ticker/bookTicker":
          return json({
            symbol: "BTC-USD",
            bidPrice: String(s.mark - 1),
            bidQty: "0.5",
            askPrice: String(s.mark + 1),
            askQty: "0.5",
            time: s.now,
          });
        case "/price/v2/depth": {
          const lvl = (side: 1 | -1) =>
            Array.from({ length: 6 }, (_, i) => [String((s.mark + side * (2 + i * 20)).toFixed(1)), "0.25"]);
          return json({ lastUpdateId: 1, E: s.now, T: s.now, bids: lvl(-1), asks: lvl(1) });
        }
        case "/price/v2/klines": {
          const start = q.get("startTime") ? Number(q.get("startTime")) : -Infinity;
          const end = q.get("endTime") ? Number(q.get("endTime")) : Infinity;
          const limit = Number(q.get("limit") ?? 1500);
          const inRange = s.candles.filter((c) => c.openTime >= start && c.openTime <= end);
          const rows = q.get("startTime") ? inRange.slice(0, limit) : inRange.slice(-limit);
          return json(rows.map(klineRow));
        }
        case "/stat/v1/stats/coin/history/funding":
          return json({
            columns: ["ts", "funding_rate"],
            data: s.candles.slice(-72).map((c) => [c.openTime, s.fundingRate]),
            symbol: "BTC-USD",
            days: 30,
          });
        case "/stat/v1/stats/coin/history/open-interest":
          return json({
            columns: ["ts", "open_interest", "volume"],
            data: s.candles.slice(-72).map((c, i) => [c.openTime, 4 + i * 0.01, 0.5]),
            symbol: "BTC-USD",
            interval: "1h",
          });
        default:
          return json({ msg: "not found" }, 404);
      }
    }
    if (url.hostname === "api.exchange.coinbase.com") {
      if (url.pathname === "/products/BTC-USD/ticker") {
        return s.coinbasePrice === null
          ? json({ message: "down" }, 503)
          : json({ price: String(s.coinbasePrice) });
      }
      if (url.pathname === "/products/BTC-USD/candles") {
        const start = q.get("start") ? Date.parse(q.get("start")!) : -Infinity;
        const end = q.get("end") ? Date.parse(q.get("end")!) : Infinity;
        const rows = s.candles
          .filter((c) => c.openTime >= start && c.openTime <= end)
          .slice(-300)
          .reverse()
          .map((c) => [c.openTime / 1000, c.low, c.high, c.open, c.close, c.volume]);
        return json(rows);
      }
    }
    if (url.hostname === "www.youtube.com") {
      if (!s.feedXml) return json("", 503);
      return new Response(s.feedXml, { status: 200, headers: { "content-type": "application/atom+xml" } });
    }
    return json({ msg: `unhandled ${url.href}` }, 404);
  }) as typeof fetch;
}

export interface FakeTelegram extends NotifierApi {
  sent: { text: string; chatId: number; edit: boolean }[];
  texts(): string[];
}

export function fakeTelegram(): FakeTelegram {
  const sent: FakeTelegram["sent"] = [];
  let id = 1;
  return {
    sent,
    texts: () => sent.map((m) => m.text),
    async sendMessage(chatId, text) {
      sent.push({ text, chatId, edit: false });
      return { message_id: id++ };
    },
    async editMessageText(chatId, _messageId, text) {
      sent.push({ text, chatId, edit: true });
      return true;
    },
  };
}

export function fakeTranscriptProvider(text: string, name = "fake"): TranscriptProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async fetch(videoId: string): Promise<Transcript | null> {
      p.calls++;
      return {
        videoId,
        language: "en",
        source: name,
        segments: text.split(". ").map((t, i) => ({ start: i * 5, duration: 5, text: t })),
        text,
        fetchedAt: 0,
      };
    },
  };
  return p;
}

/** Fixture-like EW analysis scaled around the scenario mark: a long wave-2 candidate with a usable entry zone. */
export function fixtureEw(
  mark: number,
  now: number,
): { h1: EwAnalysis; h4: EwAnalysis; h4Direction: "long" } {
  const cand = (id: string, interval: "1h" | "4h", position: EwCandidate["position"]): EwCandidate => ({
    id,
    interval,
    pattern: "impulse",
    direction: "long",
    position,
    pivots: [
      { index: 0, time: now - 40 * H, price: mark - 3_800, kind: "low" },
      { index: 20, time: now - 20 * H, price: mark + 200, kind: "high" },
    ],
    invalidation: { price: mark - 2_780, label: "wave 1 origin" },
    targets: [{ low: mark + 3_720, high: mark + 4_220, label: "1.618 x W1" }],
    entryZone: { low: mark - 1_180, high: mark - 880, label: "50-61.8% of W1" },
    score: 0.8,
    hardRulesPassed: true,
    notes: [],
  });
  const base = (interval: "1h" | "4h", candidates: EwCandidate[]): EwAnalysis => ({
    symbol: "BTC-USD",
    interval,
    asOf: now,
    lastClose: mark,
    swings: [],
    candidates,
    momentum: { rsi14: 42, rsiDivergence: "bullish", atr14: 450 },
  });
  return {
    h1: base("1h", [cand("1h-impulse-a", "1h", "in-wave-2")]),
    h4: base("4h", [cand("4h-impulse-b", "4h", "in-wave-3")]),
    h4Direction: "long",
  };
}

export interface HarnessOptions {
  llm?: LlmClient | null;
  transcript?: string | null;
  analyzeEw?: EwAnalyzer;
  telegram?: boolean;
  env?: Record<string, string>;
  scenario?: Partial<Scenario>;
  db?: Db;
}

export interface Harness {
  app: App;
  db: Db;
  scenario: Scenario;
  tg: FakeTelegram | null;
  transcript: (TranscriptProvider & { calls: number }) | null;
  /** Run queued jobs until none is due (max `max` ticks). Returns how many ran. */
  drain(max?: number): Promise<number>;
  advance(ms: number): void;
}

export function buildHarness(opts: HarnessOptions = {}): Harness {
  const scenario = makeScenario(opts.scenario);
  const env = {
    TRADING_MODE: "shadow",
    TZ: "UTC",
    STRIKE_API_BASE: STRIKE,
    DATA_DIR: ":memory:",
    ...(opts.telegram === false ? {} : { TELEGRAM_BOT_TOKEN: "000:fake", TELEGRAM_CHAT_ID: "42" }),
    ...opts.env,
  };
  const config = AppConfig.parse(env);
  const limits = RiskLimits.parse({});
  const db = opts.db ?? openDb({ path: ":memory:" }).db;
  const tg = opts.telegram === false ? null : fakeTelegram();
  const transcript =
    opts.transcript === null ? null : fakeTranscriptProvider(opts.transcript ?? DEFAULT_TRANSCRIPT);
  const deps: AppDeps = {
    config,
    limits,
    db,
    log: createLogger("silent"),
    version: "test",
    clock: { now: () => scenario.now },
    fetch: fakeFetch(scenario),
    llmClient: opts.llm ?? null,
    telegramApi: tg,
    transcriptProviders: transcript ? [transcript] : [],
    analyzeEw: opts.analyzeEw ?? (() => fixtureEw(scenario.mark, scenario.now)),
    healthPort: null,
    startBot: false,
    sleep: async () => undefined,
    runnerPollMs: 1,
    marketData: { coinbaseHistoryMs: 40 * 86_400_000, strikeSince: T0 - 40 * 86_400_000 },
  };
  const app = buildApp(deps);
  return {
    app,
    db,
    scenario,
    tg,
    transcript,
    async drain(max = 50) {
      let n = 0;
      while (n < max && (await app.runner.tick())) n++;
      await app.notifier.flush();
      return n;
    },
    advance(ms) {
      scenario.now += ms;
    },
  };
}

export const DEFAULT_TRANSCRIPT =
  "okay so looking at bitcoin on the one hour chart we have this impulse from the 76k low and what I think is a wave two " +
  "pullback into the 78,600 to 78,900 area. as long as we hold above 77,000 the count is valid and the invalidation is " +
  "obviously at 77k. the first target for wave three sits around 83,500 and then 84k above that. if we lose 77,000 then " +
  "we are probably in a bigger correction and I would look at 72k as the next support.";
