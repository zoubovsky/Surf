import { describe, expect, it } from "vitest";
import { HOUR, fakeFetch, jsonResponse, klineRow, loadFixture } from "../__fixtures__/helpers.js";
import { HttpError } from "../http.js";
import { GeoBlockedError, backfillBinance, fetchBinanceKlines, isGeoBlockResponse, parseBinanceKlines } from "./binance.js";

describe("binance geo-block detection", () => {
  const blocked = loadFixture<{ code: number; msg: string }>("binance-klines-1h.json");

  it("recorded 451 body is recognised", () => {
    expect(blocked.msg).toMatch(/restricted location/);
    expect(isGeoBlockResponse(451, JSON.stringify(blocked))).toBe(true);
    expect(isGeoBlockResponse(403, JSON.stringify(blocked))).toBe(true);
    expect(isGeoBlockResponse(403, '{"msg":"forbidden"}')).toBe(false);
    expect(isGeoBlockResponse(500, JSON.stringify(blocked))).toBe(false);
  });

  it("fetchBinanceKlines throws a typed GeoBlockedError on HTTP 451 without retrying", async () => {
    const fetch = fakeFetch(() => jsonResponse(blocked, 451));
    const err = await fetchBinanceKlines({ fetch, symbol: "BTCUSDT", interval: "1h", attempts: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeoBlockedError);
    expect(err).toBeInstanceOf(Error);
    expect((err as GeoBlockedError).status).toBe(451);
    expect((err as GeoBlockedError).venue).toBe("binance");
    expect(fetch.calls).toHaveLength(1);
  });

  it("other HTTP failures stay HttpError", async () => {
    const fetch = fakeFetch(() => jsonResponse({ code: -1121, msg: "Invalid symbol." }, 400));
    const err = await fetchBinanceKlines({ fetch, symbol: "NOPE", interval: "1h" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(GeoBlockedError);
  });

  it("backfillBinance surfaces the geo-block from the first page", async () => {
    const fetch = fakeFetch(() => jsonResponse(blocked, 451));
    await expect(backfillBinance({ fetch, symbol: "BTCUSDT", interval: "1h", from: 0, to: 10 * HOUR })).rejects.toBeInstanceOf(GeoBlockedError);
  });
});

describe("binance klines happy path", () => {
  it("parses the shared 12-element layout with venue binance and uses limit ≤ 1000", async () => {
    const fetch = fakeFetch(() => [klineRow(0), klineRow(HOUR)]);
    const out = await fetchBinanceKlines({ fetch, symbol: "BTCUSDT", interval: "1h", limit: 5000 });
    expect(out.map((c) => c.venue)).toEqual(["binance", "binance"]);
    expect(out[0]!.symbol).toBe("BTCUSDT");
    const u = fetch.calls[0]!;
    expect(u.origin + u.pathname).toBe("https://api.binance.com/api/v3/klines");
    expect(u.searchParams.get("limit")).toBe("1000");
  });

  it("parseBinanceKlines is the same parser as Strike's", () => {
    const out = parseBinanceKlines([klineRow(HOUR)], { symbol: "BTCUSDT", interval: "1h" });
    expect(out[0]).toMatchObject({ openTime: HOUR, closeTime: 2 * HOUR - 1, interval: "1h" });
  });
});
