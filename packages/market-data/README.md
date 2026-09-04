# @surf/market-data

Candle, funding and open-interest feeds for the EW engine and risk engine. Pure TypeScript, no I/O of its own:
every network call goes through an injected `fetch`, time through a `Clock`, logs through a `MarketLogger`
(`pino.Logger` from `@surf/core` satisfies it). Candles are the core `Candle` type, venue-tagged, ms timestamps,
`closeTime = openTime + interval - 1`.

## Service (what the daemon uses)

```ts
import { MarketDataService } from "@surf/market-data";
const md = new MarketDataService({ fetch, clock: systemClock, logger, repository /* your SQLite impl */ });
await md.backfill(); // Strike index 1h since 2026-03-20 + Coinbase 1h back 2 years (configurable)
await md.refresh(); // call ~1 min after each hourly close; never throws for source failures
md.getCandles("1h", 500); // last 500 *closed* Coinbase candles (default venue = long history for EW)
md.getCandles("4h", 200, "strike"); // aggregated 4h, aligned to UTC 00/04/08…, execution venue
md.latestClosed("1h", "strike"); // newest closed Strike candle — never the in-progress one
md.lastCrossCheck; // { ok, deviationPct, reason } for the latest closed Strike vs Coinbase bucket
md.funding();
md.latestFunding(); // Strike funding history (hourly points, rate per interval)
md.openInterest(); // Strike OI history (default 1h buckets, BTC units)
md.premiumIndex(); // { markPrice, indexPrice, fundingRate, nextFundingTime, time }
md.referencePrice(); // Coinbase latest closed close, else Strike index — for the risk gate
md.gaps("strike"); // missing 1h buckets detected in the series (never filled silently)
```

`backfill()`/`refresh()` return `{ errors: [{source, error}] }` and keep going when one venue is down; the risk
engine's `maxCandleAgeMs` catches a stale series. With a `repository`, backfill resumes from the last stored candle
and only _closed_ 1h/4h candles are persisted. Implement `CandleRepository { upsert(candles); range({venue, symbol,
interval, from?, to?}) }` — idempotent upsert keyed by venue+symbol+interval+openTime, ascending `range`.

## Building blocks

- `sources/strike.ts` — `fetchStrikeKlines` (`/price/v2/klines`, Binance-style rows, `limit ≤ 1500`, `priceType`
  index|mark|last), `backfillStrikeKlines`, `fetchStrikeFundingHistory` and `fetchStrikeOpenInterestHistory`
  (`/stat/v1/stats/coin/history/{funding,open-interest}` → `{columns, data, symbol, days|interval}`),
  `fetchStrikePremiumIndex`. Strike 1h history starts 2026-03-19T17:00Z.
- `sources/coinbase.ts` — `fetchCoinbaseCandles` (`[time_s, low, high, open, close, volume]`, newest first, ≤ 300),
  `backfillCoinbase` (inclusive 300-candle windows, default 5 req/s via `Pacer`), `coinbaseWindows`.
- `sources/binance.ts` — same API shape; HTTP 451 becomes a typed `GeoBlockedError` so callers can fall back.
  Not used by the service (blocked from US/cloud IPs).
- `aggregate.ts` — `aggregate(candles, "4h" | "1d")` (complete buckets only by default), `alignAndFill` → `{candles,
gaps, filled, misaligned}`; synthetic fills only with `fill: true` and every fill is listed.
- `crosscheck.ts` — `crossCheck(primary, secondary | null, maxDeviationPct)` (missing secondary is _not ok_),
  `referencePrice(coinbaseClose, strikeIndex)`.
- `store.ts` — `CandleSeries` (sorted, deduped, capped; `latestClosed(now)`, `sliceClosed`, `range`, `at`) and the
  `CandleRepository` interface.
- `http.ts` — `getJson` (retries 429/5xx/network via core `retry`, fails fast on other 4xx), `HttpError`, `Pacer`.

## Tests

`pnpm exec vitest run packages/market-data`. Parsers run against recorded responses in `src/__fixtures__/`.
`MARKET_LIVE_TESTS=1` additionally hits the real Strike and Coinbase endpoints and checks the venues agree within 1%.
