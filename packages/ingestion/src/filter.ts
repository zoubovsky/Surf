/**
 * Title-based filtering for the More Crypto Online feed.
 * Titles are untrusted text; these helpers only run regexes over them.
 */

/** Bitcoin videos reliably contain "Bitcoin" (occasionally "BTC"). Do NOT filter on "Elliott Wave". */
export const BITCOIN_TITLE_RE = /\bbitcoin\b|\bbtc\b/i;

/** Other assets the channel covers; used to flag combined "Bitcoin & Ethereum" style videos. */
export const OTHER_ASSET_RE =
  /\b(ethereum|eth|solana|sol|xrp|ripple|hype|hyperliquid|cardano|ada|polygon|matic|avalanche|avax|chainlink|dogecoin|doge|bnb|litecoin|ltc|sui|altcoins?|total\s?[23])\b/gi;

/** YouTube Shorts are at most 3 minutes (since Oct 2024). */
export const SHORT_MAX_SEC = 180;

export function isBitcoinTitle(title: string): boolean {
  return BITCOIN_TITLE_RE.test(title);
}

/**
 * True when a known duration marks the video as a Short. Unknown duration returns false:
 * the UULF playlist already excludes Shorts, so absence of data is not evidence.
 */
export function isShortLike(durationSec?: number | null): boolean {
  return typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 && durationSec <= SHORT_MAX_SEC;
}

export interface TitleClass {
  asset: "BTC" | "other";
  /** Bitcoin video that also names another asset ("Bitcoin & Ethereum: ..."). */
  combined: boolean;
  /** Lower-cased other-asset tokens found in the title, de-duplicated. */
  others: string[];
}

export function classifyTitle(title: string): TitleClass {
  const btc = isBitcoinTitle(title);
  const others = Array.from(new Set(Array.from(title.matchAll(OTHER_ASSET_RE), (m) => m[0].toLowerCase())));
  return { asset: btc ? "BTC" : "other", combined: btc && others.length > 0, others };
}
