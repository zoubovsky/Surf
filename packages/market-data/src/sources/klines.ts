import { z } from "zod";
import { INTERVAL_MS, type Candle, type Interval } from "@surf/core";
import { normalizeSeries } from "../aggregate.js";

/** Accepts a number or numeric string and yields a finite number. */
export const numeric = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (v === "" || !Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: `not a finite number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

/**
 * Binance-style 12-element kline row:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
 */
export const BinanceStyleKlineRow = z.tuple([
  z.number().int(), // openTime
  numeric, // open
  numeric, // high
  numeric, // low
  numeric, // close
  numeric, // volume
  z.number().int(), // closeTime
  numeric, // quoteVolume
  numeric, // trades
  numeric, // takerBuyBase
  numeric, // takerBuyQuote
  z.unknown(), // ignore
]);
export type BinanceStyleKlineRow = z.infer<typeof BinanceStyleKlineRow>;

export const BinanceStyleKlines = z.array(BinanceStyleKlineRow);

export interface KlineContext {
  venue: string;
  symbol: string;
  interval: Interval;
}

/** Parse a Binance-format kline array into sorted, deduped `Candle`s. Throws on malformed input. */
export function parseBinanceStyleKlines(raw: unknown, ctx: KlineContext): Candle[] {
  const rows = BinanceStyleKlines.parse(raw);
  const ms = INTERVAL_MS[ctx.interval];
  const candles: Candle[] = rows.map((r) => {
    const openTime = r[0];
    // Venues report closeTime as openTime + interval - 1 ms; normalise so every venue agrees.
    const closeTime = r[6] > openTime ? r[6] : openTime + ms - 1;
    return {
      venue: ctx.venue,
      symbol: ctx.symbol,
      interval: ctx.interval,
      openTime,
      closeTime,
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: Math.max(0, r[5]),
    };
  });
  return normalizeSeries(candles);
}
