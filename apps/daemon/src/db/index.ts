import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;
export { schema };

const here = dirname(fileURLToPath(import.meta.url));
/** Works from both src/ (tsx) and dist/ (node): apps/daemon/{src|dist}/db → apps/daemon/drizzle */
const MIGRATIONS_DIR = resolve(here, "../../drizzle");

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  migrationsFolder?: string;
}

export function openDb(opts: OpenDbOptions): { db: Db; sqlite: Database.Database; close: () => void } {
  if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
  const sqlite = new Database(opts.path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_DIR });
  return { db, sqlite, close: () => sqlite.close() };
}

/** Simple JSON key-value helpers over the kv table. */
export function kvGet<T>(db: Db, key: string): T | null {
  const row = db.select().from(schema.kv).where(eq(schema.kv.key, key)).get();
  return row ? (row.value as T) : null;
}

export function kvSet(db: Db, key: string, value: unknown, now = Date.now()): void {
  db.insert(schema.kv)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.kv.key, set: { value, updatedAt: now } })
    .run();
}
