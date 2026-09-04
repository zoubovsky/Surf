import { describe, expect, it } from "vitest";
import type { Candle } from "@surf/core";
import { HOUR, coinbaseRow, fakeFetch, jsonResponse, klineRow, loadFixture } from "./__fixtures__/helpers.js";
import { MarketDataService } from "./service.js";
import type { CandleRangeQuery, CandleRepository } from "./store.js";
import type { MarketLogger } from "./types.js";

const STRIKE_START = Date.UTC(2026, 2, 20);

interface World {
  now: number;
  /** Multiplier applied to Coinbase prices vs Strike's, to simulate divergence. */
  coinbaseScale: number;
  strikeFail?: number;
}

/** Fake venue: both APIs serve the same synthetic price path (Coinbase scaled by `coinbaseScale`). */
function venueServer(world: World) {
  return fakeFetch((u) => {
    const currentOpen = Math.floor(world.now / HOUR) * HOUR;
    if (u.pathname === "/price/v2/klines") {
      if (world.strikeFail) return jsonResponse("down", world.strikeFail);
      const start = Number(u.searchParams.get("startTime") ?? STRIKE_START);
      const end = Math.min(Number(u.searchParams.get("endTime") ?? Number.MAX_SAFE_INTEGER), currentOpen);
      const limit = Number(u.searchParams.get("limit") ?? 500);
      const rows: unknown[][] = [];
      for (let t = Math.max(start, STRIKE_START); t <= end && rows.length < limit; t += HOUR) rows.push(klineRow(t));
      return rows;
    }
    if (u.pathname === "/products/BTC-USD/candles") {
      const end = Math.min(Date.parse(u.searchParams.get("end")!), currentOpen);
      const start = Date.parse(u.searchParams.get("start")!);
      if ((end - start) / HOUR + 1 > 300) return jsonResponse({ message: "granularity too small for the requested time range" }, 400);
      const rows: number[][] = [];
      for (let t = end; t >= start; t -= HOUR) rows.push(coinbaseRow(t, world.coinbaseScale));
      return rows;
    }
    if (u.pathname.endsWith("/history/funding")) return loadFixture("strike-funding-history.json");
    if (u.pathname.endsWith("/history/open-interest")) return loadFixture("strike-open-interest-history.json");
    if (u.pathname === "/price/v2/premiumIndex") return loadFixture("strike-premium-index.json");
    return jsonResponse({ message: "NotFound" }, 404);
  });
}

class MemoryRepo implements CandleRepository {
  rows = new Map<string, Candle>();
  upserts = 0;
  async upsert(candles: readonly Candle[]): Promise<void> {
    this.upserts++;
    for (const c of candles) this.rows.set(`${c.venue}|${c.symbol}|${c.interval}|${c.openTime}`, c);
  }
  async range(q: CandleRangeQuery): Promise<Candle[]> {
    return [...this.rows.values()]
      .filter((c) => c.venue === q.venue && c.symbol === q.symbol && c.interval === q.interval)
      .filter((c) => (q.from === undefined || c.openTime >= q.from) && (q.to === undefined || c.openTime <= q.to))
      .sort((a, b) => a.openTime - b.openTime);
  }
}

function collectLogger(): MarketLogger & { warns: unknown[] } {
  const warns: unknown[] = [];
  return { warns, debug() {}, info() {}, warn(obj) { warns.push(obj); }, error(obj) { warns.push(obj); } };
}

function make(world: World, extra: Partial<ConstructorParameters<typeof MarketDataService>[0]> = {}) {
  const fetch = venueServer(world);
  const sleeps: number[] = [];
  const logger = collectLogger();
  const svc = new MarketDataService({
    fetch,
    clock: { now: () => world.now },
    logger,
    sleep: async (ms) => void sleeps.push(ms),
    request: { attempts: 1 },
    strikeSince: world.now - 30 * HOUR,
    coinbaseHistoryMs: 40 * HOUR,
    ...extra,
  });
  return { svc, fetch, sleeps, logger };
}

describe("MarketDataService.backfill", () => {
  const NOW = Date.UTC(2026, 8, 4, 10, 30); // 10:30 UTC → 10:00 candle is open

  it("loads Strike + Coinbase 1h, aggregates 4h, cross-checks, and hides the open candle", async () => {
    const world: World = { now: NOW, coinbaseScale: 1.0005 };
    const { svc, fetch } = make(world);
    const summary = await svc.backfill();

    expect(summary.errors).toEqual([]);
    expect(summary.strike.fetched).toBe(31); // 30h ago … 10:00 inclusive
    expect(summary.coinbase.fetched).toBe(41);
    expect(summary.crossCheck?.ok).toBe(true);
    expect(summary.crossCheck?.reason).toBe("ok");
    expect(summary.crossCheck?.deviationPct).toBeCloseTo(0.05, 2);

    // execution truth and analysis series are both there and venue-tagged
    const strikeLatest = svc.latestClosed("1h", "strike")!;
    expect(strikeLatest.openTime).toBe(Date.UTC(2026, 8, 4, 9));
    expect(strikeLatest.venue).toBe("strike");
    expect(svc.latestClosed("1h")!.venue).toBe("coinbase"); // default venue
    expect(svc.getSeries("strike", "1h").latest()!.openTime).toBe(Date.UTC(2026, 8, 4, 10)); // open candle held…
    expect(svc.getCandles("1h", 100, "strike").every((c) => c.closeTime <= NOW)).toBe(true); // …but never served
    expect(svc.getCandles("1h", 5, "coinbase").map((c) => c.openTime)).toEqual([5, 6, 7, 8, 9].map((h) => Date.UTC(2026, 8, 4, h)));

    // 4h aggregation aligned to UTC 00/04/08 — bucket 08–11 is incomplete so latest closed is 04:00
    const fourH = svc.getCandles("4h", 10, "coinbase");
    expect(fourH.every((c) => c.openTime % (4 * HOUR) === 0)).toBe(true);
    expect(svc.latestClosed("4h", "coinbase")!.openTime).toBe(Date.UTC(2026, 8, 4, 4));
    expect(svc.getSeries("coinbase", "4h").latest()!.openTime).toBe(Date.UTC(2026, 8, 4, 4)); // partial 08h bucket not built

    // stats
    expect(svc.funding().length).toBeGreaterThan(700);
    expect(svc.latestFunding()!.ts).toBe(1788537600000);
    expect(svc.openInterest().length).toBeGreaterThan(10);
    expect(svc.premiumIndex()!.nextFundingTime).toBe(1788541200000);
    expect(svc.referencePrice()).toBe(svc.latestClosed("1h", "coinbase")!.close);
    expect(svc.gaps("strike")).toEqual([]);

    const paths = fetch.calls.map((u) => u.pathname);
    expect(paths.filter((p) => p === "/price/v2/klines")).toHaveLength(1);
    expect(paths.filter((p) => p === "/products/BTC-USD/candles")).toHaveLength(1);
    expect(paths).toContain("/stat/v1/stats/coin/history/funding");
    expect(paths).toContain("/stat/v1/stats/coin/history/open-interest");
    expect(paths).toContain("/price/v2/premiumIndex");
  });

  it("paginates Coinbase in ≤300-candle windows with pacing", async () => {
    const world: World = { now: NOW, coinbaseScale: 1 };
    const { svc, fetch, sleeps } = make(world, { coinbaseHistoryMs: 700 * HOUR });
    const summary = await svc.backfill();
    expect(summary.errors).toEqual([]);
    expect(summary.coinbase.fetched).toBe(701);
    expect(fetch.calls.filter((u) => u.pathname === "/products/BTC-USD/candles")).toHaveLength(3);
    expect(sleeps).toEqual([200, 400]); // 5 req/s with a frozen clock
  });

  it("flags divergence between venues", async () => {
    const world: World = { now: NOW, coinbaseScale: 1.02 };
    const { svc, logger } = make(world);
    const summary = await svc.backfill();
    expect(summary.crossCheck).toMatchObject({ ok: false, reason: "deviation-exceeded" });
    expect(svc.lastCrossCheck?.deviationPct).toBeGreaterThan(1.9);
    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it("keeps going when one source fails and reports the error", async () => {
    const world: World = { now: NOW, coinbaseScale: 1, strikeFail: 503 };
    const { svc } = make(world);
    const summary = await svc.backfill();
    expect(summary.errors.map((e) => e.source)).toEqual(["strike.klines"]);
    expect(summary.strike.fetched).toBe(0);
    expect(summary.coinbase.fetched).toBe(41);
    expect(svc.latestClosed("1h", "strike")).toBeNull();
    expect(svc.lastCrossCheck).toBeNull();
    expect(svc.latestClosed("1h", "coinbase")).not.toBeNull();
  });

  it("resumes from the repository and persists only closed candles", async () => {
    const world: World = { now: NOW, coinbaseScale: 1 };
    const repo = new MemoryRepo();
    // pre-seed Strike with everything up to 05:00
    for (let t = Date.UTC(2026, 8, 3, 4); t <= Date.UTC(2026, 8, 4, 5); t += HOUR) {
      const [row] = venueServerRows(t);
      await repo.upsert([row]);
    }
    const { svc, fetch } = make(world, { repository: repo });
    await svc.backfill();
    const klines = fetch.calls.find((u) => u.pathname === "/price/v2/klines")!;
    expect(Number(klines.searchParams.get("startTime"))).toBe(Date.UTC(2026, 8, 4, 6));
    expect(svc.getSeries("strike", "1h").size).toBe(31);
    const stored = await repo.range({ venue: "strike", symbol: "BTC-USD", interval: "1h" });
    expect(stored.every((c) => c.closeTime <= NOW)).toBe(true);
    expect(stored[stored.length - 1]!.openTime).toBe(Date.UTC(2026, 8, 4, 9));
    const stored4h = await repo.range({ venue: "coinbase", symbol: "BTC-USD", interval: "4h" });
    expect(stored4h.length).toBeGreaterThan(0);
    expect(stored4h.every((c) => c.openTime % (4 * HOUR) === 0 && c.closeTime <= NOW)).toBe(true);
  });
});

/** Build the Candle the fake Strike server would produce for openTime t. */
function venueServerRows(t: number): Candle[] {
  const r = klineRow(t) as [number, string, string, string, string, string, number];
  return [{ venue: "strike", symbol: "BTC-USD", interval: "1h", openTime: r[0], closeTime: r[6], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }];
}

describe("MarketDataService.refresh", () => {
  const NOW = Date.UTC(2026, 8, 4, 10, 30);

  it("picks up the newly closed hour, updates aggregates and the cross-check", async () => {
    const world: World = { now: NOW, coinbaseScale: 1 };
    const { svc, fetch } = make(world);
    await svc.backfill();
    fetch.calls.length = 0;

    // nothing new yet
    let res = await svc.refresh();
    expect(res.errors).toEqual([]);
    expect(res.newCandles).toEqual({ strike: 0, coinbase: 0 });
    expect(res.strikeLatestClosed!.openTime).toBe(Date.UTC(2026, 8, 4, 9));

    // an hour later (11:01): the 10:00 candle has closed, 11:00 is open
    world.now = Date.UTC(2026, 8, 4, 11, 1);
    res = await svc.refresh();
    expect(res.newCandles).toEqual({ strike: 1, coinbase: 1 });
    expect(res.strikeLatestClosed!.openTime).toBe(Date.UTC(2026, 8, 4, 10));
    expect(res.coinbaseLatestClosed!.openTime).toBe(Date.UTC(2026, 8, 4, 10));
    expect(res.crossCheck).toMatchObject({ ok: true, primary: { openTime: Date.UTC(2026, 8, 4, 10) } });
    expect(svc.latestClosed("1h", "strike")!.openTime).toBe(Date.UTC(2026, 8, 4, 10));
    expect(svc.getCandles("1h", 1, "strike")[0]!.openTime).toBe(Date.UTC(2026, 8, 4, 10));

    // the refresh only asked for the tail
    const klines = fetch.calls.filter((u) => u.pathname === "/price/v2/klines").pop()!;
    expect(Number(klines.searchParams.get("startTime"))).toBe(Date.UTC(2026, 8, 4, 10));
    expect(Number(klines.searchParams.get("limit"))).toBeLessThan(10);

    // 12:01: the 08–11 4h bucket is complete now
    world.now = Date.UTC(2026, 8, 4, 12, 1);
    res = await svc.refresh();
    expect(svc.latestClosed("4h", "coinbase")!.openTime).toBe(Date.UTC(2026, 8, 4, 8));
    expect(svc.latestClosed("4h", "strike")!.openTime).toBe(Date.UTC(2026, 8, 4, 8));
    expect(svc.getCandles("4h", 1, "strike")[0]!.close).toBe(svc.getSeries("strike", "1h").at(Date.UTC(2026, 8, 4, 11))!.close);
  });

  it("survives a source outage and reports it without throwing", async () => {
    const world: World = { now: NOW, coinbaseScale: 1 };
    const { svc } = make(world);
    await svc.backfill();
    world.now = Date.UTC(2026, 8, 4, 11, 1);
    world.strikeFail = 500;
    const res = await svc.refresh();
    expect(res.errors.map((e) => e.source)).toEqual(["strike.klines"]);
    expect(res.newCandles.coinbase).toBe(1);
    // the 10:00 candle was already held (open) since backfill and has since closed; nothing newer is known
    expect(res.strikeLatestClosed!.openTime).toBe(Date.UTC(2026, 8, 4, 10));
    expect(svc.getSeries("strike", "1h").latest()!.openTime).toBe(Date.UTC(2026, 8, 4, 10)); // 11:00 never arrived
    expect(res.crossCheck!.primary!.openTime).toBe(Date.UTC(2026, 8, 4, 10));
  });
});
