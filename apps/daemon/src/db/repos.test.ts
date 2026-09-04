import { describe, expect, it } from "vitest";
import { openDb } from "./index.js";
import { SqliteCandleRepository, SqliteSeenStore } from "./repos.js";

const c = (openTime: number, close: number) => ({
  venue: "strike",
  symbol: "BTC-USD",
  interval: "1h" as const,
  openTime,
  closeTime: openTime + 3_599_999,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1,
});

describe("SqliteCandleRepository", () => {
  it("upserts idempotently and ranges ascending", async () => {
    const { db } = openDb({ path: ":memory:" });
    const repo = new SqliteCandleRepository(db);
    await repo.upsert([c(3_600_000, 2), c(0, 1)]);
    await repo.upsert([c(3_600_000, 2.5)]);
    const all = await repo.range({ venue: "strike", symbol: "BTC-USD", interval: "1h" });
    expect(all.map((x) => x.close)).toEqual([1, 2.5]);
    const from = await repo.range({ venue: "strike", symbol: "BTC-USD", interval: "1h", from: 3_600_000 });
    expect(from).toHaveLength(1);
    const limited = await repo.range({
      venue: "strike",
      symbol: "BTC-USD",
      interval: "1h",
      limit: 1,
    } as never);
    expect(limited.map((x) => x.openTime)).toEqual([3_600_000]);
  });

  it("handles large batches in chunks", async () => {
    const { db } = openDb({ path: ":memory:" });
    const repo = new SqliteCandleRepository(db);
    const many = Array.from({ length: 1000 }, (_, i) => c(i * 3_600_000, 100 + i));
    await repo.upsert(many);
    const all = await repo.range({ venue: "strike", symbol: "BTC-USD", interval: "1h" });
    expect(all).toHaveLength(1000);
  });
});

describe("SqliteSeenStore", () => {
  it("records seen videos with status by match", () => {
    const { db } = openDb({ path: ":memory:" });
    const store = new SqliteSeenStore(db, () => 5);
    expect(store.has("a")).toBe(false);
    store.add("a", { title: "Bitcoin x", publishedAt: 1, matched: true } as never);
    store.add("b", { title: "ETH y", publishedAt: 2, matched: false } as never);
    store.add("a", { title: "dup", publishedAt: 1, matched: true } as never);
    expect(store.has("a")).toBe(true);
    const rows = db.select().from(db._.fullSchema.videos).all();
    expect(rows.map((r) => [r.videoId, r.status])).toEqual([
      ["a", "new"],
      ["b", "not-relevant"],
    ]);
  });
});
