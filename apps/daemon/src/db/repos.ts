import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Candle, Interval } from "@surf/core";
import type { CandleRangeQuery, CandleRepository } from "@surf/market-data";
import type { SeenMeta, SeenStore } from "@surf/ingestion";
import { schema, type Db } from "./index.js";

/** SQLite-backed candle store for MarketDataService. */
export class SqliteCandleRepository implements CandleRepository {
  constructor(private readonly db: Db) {}

  async upsert(candles: readonly Candle[]): Promise<void> {
    if (candles.length === 0) return;
    const insert = this.db
      .insert(schema.candles)
      .values(candles.map((c) => ({ ...c })))
      .onConflictDoUpdate({
        target: [
          schema.candles.venue,
          schema.candles.symbol,
          schema.candles.interval,
          schema.candles.openTime,
        ],
        set: {
          closeTime: sql`excluded.close_time`,
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
        },
      });
    // chunk to stay under SQLite's variable limit
    const CHUNK = 400;
    if (candles.length <= CHUNK) {
      insert.run();
      return;
    }
    this.db.transaction((tx) => {
      for (let i = 0; i < candles.length; i += CHUNK) {
        tx.insert(schema.candles)
          .values(candles.slice(i, i + CHUNK).map((c) => ({ ...c })))
          .onConflictDoUpdate({
            target: [
              schema.candles.venue,
              schema.candles.symbol,
              schema.candles.interval,
              schema.candles.openTime,
            ],
            set: {
              closeTime: sql`excluded.close_time`,
              open: sql`excluded.open`,
              high: sql`excluded.high`,
              low: sql`excluded.low`,
              close: sql`excluded.close`,
              volume: sql`excluded.volume`,
            },
          })
          .run();
      }
    });
  }

  async range(q: CandleRangeQuery): Promise<Candle[]> {
    const conds = [
      eq(schema.candles.venue, q.venue),
      eq(schema.candles.symbol, q.symbol),
      eq(schema.candles.interval, q.interval),
    ];
    if (q.from !== undefined) conds.push(gte(schema.candles.openTime, q.from));
    if (q.to !== undefined) conds.push(lte(schema.candles.openTime, q.to));
    const limit = (q as { limit?: number }).limit;
    if (limit !== undefined && q.from === undefined) {
      const rows = this.db
        .select()
        .from(schema.candles)
        .where(and(...conds))
        .orderBy(desc(schema.candles.openTime))
        .limit(limit)
        .all();
      return rows.reverse().map((r) => ({ ...r, interval: r.interval as Interval }));
    }
    let query = this.db
      .select()
      .from(schema.candles)
      .where(and(...conds))
      .orderBy(asc(schema.candles.openTime))
      .$dynamic();
    if (limit !== undefined) query = query.limit(limit);
    return query.all().map((r) => ({ ...r, interval: r.interval as Interval }));
  }
}

/** SQLite-backed seen-video store for the feed watcher. */
export class SqliteSeenStore implements SeenStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  has(videoId: string): boolean {
    return (
      this.db
        .select({ id: schema.videos.videoId })
        .from(schema.videos)
        .where(eq(schema.videos.videoId, videoId))
        .get() !== undefined
    );
  }

  add(videoId: string, meta: SeenMeta): void {
    this.db
      .insert(schema.videos)
      .values({
        videoId,
        title: meta.title,
        publishedAt: meta.publishedAt,
        seenAt: this.now(),
        status: meta.matched ? "new" : "not-relevant",
      })
      .onConflictDoNothing()
      .run();
  }
}
