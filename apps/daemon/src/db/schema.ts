import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/* ---------- market data ---------- */
export const candles = sqliteTable(
  "candles",
  {
    venue: text("venue").notNull(),
    symbol: text("symbol").notNull(),
    interval: text("interval").notNull(),
    openTime: integer("open_time").notNull(),
    closeTime: integer("close_time").notNull(),
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    volume: real("volume").notNull(),
  },
  (t) => [primaryKey({ columns: [t.venue, t.symbol, t.interval, t.openTime] })],
);

export const funding = sqliteTable(
  "funding",
  {
    symbol: text("symbol").notNull(),
    time: integer("time").notNull(),
    rateHourly: real("rate_hourly").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.time] })],
);

export const openInterest = sqliteTable(
  "open_interest",
  {
    symbol: text("symbol").notNull(),
    time: integer("time").notNull(),
    value: real("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.time] })],
);

/* ---------- ingestion ---------- */
export const videos = sqliteTable("videos", {
  videoId: text("video_id").primaryKey(),
  title: text("title").notNull(),
  publishedAt: integer("published_at").notNull(),
  seenAt: integer("seen_at").notNull(),
  status: text("status").notNull(), // new | transcript-pending | ingested | not-relevant | unavailable
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: integer("last_attempt_at"),
  note: text("note"),
});

export const transcripts = sqliteTable("transcripts", {
  videoId: text("video_id").primaryKey(),
  language: text("language").notNull(),
  source: text("source").notNull(),
  text: text("text").notNull(),
  segments: text("segments", { mode: "json" }),
  fetchedAt: integer("fetched_at").notNull(),
});

export const signals = sqliteTable("signals", {
  videoId: text("video_id").primaryKey(),
  publishedAt: integer("published_at").notNull(),
  triage: text("triage", { mode: "json" }).notNull(),
  prior: text("prior", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

/* ---------- loops ---------- */
export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // hourly | video | review | calibration | brief
    trigger: text("trigger", { mode: "json" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    terminal: text("terminal"),
    summary: text("summary"),
    costUsd: real("cost_usd").notNull().default(0),
  },
  (t) => [index("cycles_started_idx").on(t.startedAt)],
);

export const stages = sqliteTable(
  "stages",
  {
    cycleId: text("cycle_id").notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull(), // done | failed
    inputHash: text("input_hash"),
    output: text("output", { mode: "json" }),
    model: text("model"),
    usage: text("usage", { mode: "json" }),
    costUsd: real("cost_usd").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.cycleId, t.stage] })],
);

export const ewCounts = sqliteTable(
  "ew_counts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cycleId: text("cycle_id").notNull(),
    interval: text("interval").notNull(),
    asOf: integer("as_of").notNull(),
    analysis: text("analysis", { mode: "json" }).notNull(),
  },
  (t) => [index("ew_counts_asof_idx").on(t.asOf)],
);

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  plan: text("plan", { mode: "json" }).notNull(),
  review: text("review", { mode: "json" }),
  risk: text("risk", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

/* ---------- execution ---------- */
export const orders = sqliteTable(
  "orders",
  {
    clientOrderId: text("client_order_id").primaryKey(),
    strategyId: text("strategy_id"),
    exchangeOrderId: text("exchange_order_id"),
    cycleId: text("cycle_id"),
    proposalId: text("proposal_id"),
    positionId: text("position_id"),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    type: text("type").notNull(),
    role: text("role").notNull(), // entry | stop | take-profit | exit | adjust
    size: real("size").notNull(),
    price: real("price"),
    stopPrice: real("stop_price"),
    status: text("status").notNull(), // pending | open | filled | cancelled | rejected | expired
    filledSize: real("filled_size").notNull().default(0),
    avgFillPrice: real("avg_fill_price"),
    placedAt: integer("placed_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    raw: text("raw", { mode: "json" }),
  },
  (t) => [index("orders_status_idx").on(t.status), index("orders_position_idx").on(t.positionId)],
);

export const fills = sqliteTable(
  "fills",
  {
    id: text("id").primaryKey(),
    clientOrderId: text("client_order_id"),
    exchangeOrderId: text("exchange_order_id"),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    price: real("price").notNull(),
    size: real("size").notNull(),
    fee: real("fee").notNull().default(0),
    role: text("role"), // maker | taker
    realizedPnl: real("realized_pnl").notNull().default(0),
    time: integer("time").notNull(),
  },
  (t) => [index("fills_time_idx").on(t.time)],
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id"),
    proposalId: text("proposal_id"),
    symbol: text("symbol").notNull(),
    direction: text("direction").notNull(),
    size: real("size").notNull(),
    entryPrice: real("entry_price"),
    plannedEntry: real("planned_entry"),
    stopLoss: real("stop_loss").notNull(),
    takeProfit: real("take_profit").notNull(),
    initialStop: real("initial_stop").notNull(),
    leverage: real("leverage").notNull(),
    riskUsd: real("risk_usd").notNull(),
    status: text("status").notNull(), // resting | open | closed | cancelled
    openedAt: integer("opened_at"),
    closedAt: integer("closed_at"),
    exitPrice: real("exit_price"),
    exitReason: text("exit_reason"), // stop | take-profit | invalidation | manual | flatten | expired
    realizedPnl: real("realized_pnl"),
    realizedR: real("realized_r"),
    fees: real("fees").notNull().default(0),
    fundingPaid: real("funding_paid").notNull().default(0),
    mae: real("mae"),
    mfe: real("mfe"),
    journal: text("journal", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("positions_status_idx").on(t.status)],
);

/* ---------- feedback loop ---------- */
export const tradeReviews = sqliteTable("trade_reviews", {
  positionId: text("position_id").primaryKey(),
  review: text("review", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const lessons = sqliteTable("lessons", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  evidence: text("evidence", { mode: "json" }).notNull(),
  status: text("status").notNull(), // active | retired
  createdAt: integer("created_at").notNull(),
  reviewAfterTrades: integer("review_after_trades").notNull(),
  retiredAt: integer("retired_at"),
  retiredReason: text("retired_reason"),
});

export const paramsVersions = sqliteTable("params_versions", {
  version: integer("version").primaryKey({ autoIncrement: true }),
  params: text("params", { mode: "json" }).notNull(),
  reason: text("reason").notNull(),
  backtest: text("backtest", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

/* ---------- system ---------- */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    singletonKey: text("singleton_key"),
    payload: text("payload", { mode: "json" }),
    runAt: integer("run_at").notNull(),
    status: text("status").notNull(), // queued | running | done | failed | dead
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    result: text("result", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lockedAt: integer("locked_at"),
  },
  (t) => [
    uniqueIndex("jobs_singleton_idx").on(t.singletonKey),
    index("jobs_status_runat_idx").on(t.status, t.runAt),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    level: text("level").notNull(), // info | warn | critical
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }),
  },
  (t) => [index("events_at_idx").on(t.at)],
);

export const llmSpend = sqliteTable("llm_spend", {
  day: text("day").primaryKey(), // YYYY-MM-DD in TZ
  usd: real("usd").notNull().default(0),
  calls: integer("calls").notNull().default(0),
});

export const telegramMessages = sqliteTable("telegram_messages", {
  key: text("key").primaryKey(),
  messageId: integer("message_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
