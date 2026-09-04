import type { AccountSnapshot, Direction, Logger, MarketSnapshot } from "@surf/core";
import { toMarketSnapshot, type BookTicker, type Depth } from "@surf/strike";
import type { AppContext } from "../context.js";

export const COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";

/** Live Coinbase spot price for the reference-deviation gate; null on any failure. */
export async function coinbaseTickerPrice(
  fetchImpl: typeof fetch,
  log: Logger,
  url = COINBASE_TICKER_URL,
): Promise<number | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "surf-daemon" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { price?: string | number };
    const price = Number(body.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    log.warn({ err: String(err) }, "coinbase ticker unavailable");
    return null;
  }
}

export interface Snapshots {
  account: AccountSnapshot;
  market: MarketSnapshot;
  /** Venue limit-price bound as a fraction (0.05 default). */
  limitTakeBound: number;
}

/** Fresh account and market snapshots from the executor and Strike public endpoints. */
export async function takeSnapshots(ctx: AppContext, direction: Direction | null = null): Promise<Snapshots> {
  const now = ctx.now();
  const symbol = ctx.symbol;
  const [account, premiumIndex, bookTicker, depth, coinbase] = await Promise.all([
    ctx.executor.account(symbol, now),
    ctx.rest.premiumIndex(symbol),
    ctx.rest.bookTicker(symbol).catch((): BookTicker | null => null),
    ctx.rest.depth(symbol, 100).catch((): Depth | null => null),
    coinbaseTickerPrice(ctx.fetch, ctx.log),
  ]);
  const referencePrice = coinbase ?? ctx.md.referencePrice();
  const lastCandle = ctx.md.latestClosed("1h", "strike") ?? ctx.md.latestClosed("1h", "coinbase");
  const market = toMarketSnapshot({
    premiumIndex,
    bookTicker,
    depth,
    referencePrice,
    lastCandleCloseTime: lastCandle?.closeTime ?? null,
    direction,
    asOf: now,
  });
  ctx.health.markFeed("strike-rest", "ok", null, now);
  const limitTakeBound = ctx.rest.cachedRules(symbol)?.limitTakeBound ?? 0.05;
  return { account, market, limitTakeBound };
}
