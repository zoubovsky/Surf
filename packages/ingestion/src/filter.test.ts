import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./feed.js";
import { classifyTitle, isBitcoinTitle, isShortLike, SHORT_MAX_SEC } from "./filter.js";

const titles = parseFeed(readFileSync(new URL("./__fixtures__/uulf-feed.xml", import.meta.url), "utf8")).videos.map((v) => v.title);

describe("isBitcoinTitle on real MCO titles", () => {
  it("selects exactly the Bitcoin videos from the live fixture", () => {
    expect(titles.filter(isBitcoinTitle)).toEqual([
      "Bitcoin Price: Why 79K Is the Level to Watch Today",
      "Bitcoin Must Hold These 3 Support Levels",
      "Bitcoin Must Hold This Support or Risk a Deeper Drop",
      "The Bitcoin Trap Comes After the Breakout",
      "Is the Bitcoin Breakout Imminent? Key Levels to Watch",
    ]);
  });

  it("rejects the other assets in the same feed window", () => {
    const rejected = titles.filter((t) => !isBitcoinTitle(t));
    expect(rejected).toHaveLength(10);
    for (const t of rejected) expect(t).toMatch(/Ethereum|HYPE|XRP|Solana/i);
  });

  it("matches BTC, combined titles and possessives; ignores substrings", () => {
    expect(isBitcoinTitle("BTC Update: 79K Rejected Again")).toBe(true);
    expect(isBitcoinTitle("Bitcoin & Ethereum: The Levels That Matter")).toBe(true);
    expect(isBitcoinTitle("Bitcoin's Next Move")).toBe(true);
    expect(isBitcoinTitle("bitcoin elliott wave analysis")).toBe(true);
    expect(isBitcoinTitle("Bitcoins vs. Altcoins")).toBe(false);
    expect(isBitcoinTitle("WBTC Depeg Explained")).toBe(false);
    expect(isBitcoinTitle("Ethereum Must Clear THIS Level to Confirm the Uptrend")).toBe(false);
  });
});

describe("classifyTitle", () => {
  it("flags combined Bitcoin + other-asset titles", () => {
    expect(classifyTitle("Bitcoin & Ethereum: The Levels That Matter")).toEqual({ asset: "BTC", combined: true, others: ["ethereum"] });
    expect(classifyTitle("BTC, ETH and SOL – Weekend Update")).toEqual({ asset: "BTC", combined: true, others: ["eth", "sol"] });
  });
  it("pure Bitcoin titles are not combined", () => {
    expect(classifyTitle("Bitcoin Price: Why 79K Is the Level to Watch Today")).toEqual({ asset: "BTC", combined: false, others: [] });
  });
  it("other assets are never combined", () => {
    expect(classifyTitle("Solana: $110 Is the Only Level That Matters")).toEqual({ asset: "other", combined: false, others: ["solana"] });
    expect(classifyTitle("XRP on its way to $11 - The price levels that decide").asset).toBe("other");
  });
});

describe("isShortLike", () => {
  it("uses the verified durations from the research doc", () => {
    expect(isShortLike(83)).toBe(true); // Z0HPtP95Fx0, the Short re-post
    expect(isShortLike(535)).toBe(false); // bBNu9b3HyWw, long-form
    expect(isShortLike(1082)).toBe(false); // 3wXfppSKkpg
  });
  it("boundary and unknown", () => {
    expect(isShortLike(SHORT_MAX_SEC)).toBe(true);
    expect(isShortLike(SHORT_MAX_SEC + 1)).toBe(false);
    expect(isShortLike(undefined)).toBe(false);
    expect(isShortLike(null)).toBe(false);
    expect(isShortLike(0)).toBe(false);
    expect(isShortLike(NaN)).toBe(false);
  });
});
