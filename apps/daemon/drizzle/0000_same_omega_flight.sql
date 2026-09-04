CREATE TABLE `candles` (
	`venue` text NOT NULL,
	`symbol` text NOT NULL,
	`interval` text NOT NULL,
	`open_time` integer NOT NULL,
	`close_time` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	PRIMARY KEY(`venue`, `symbol`, `interval`, `open_time`)
);
--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`trigger` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`terminal` text,
	`summary` text,
	`cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cycles_started_idx` ON `cycles` (`started_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `ew_counts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cycle_id` text NOT NULL,
	`interval` text NOT NULL,
	`as_of` integer NOT NULL,
	`analysis` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ew_counts_asof_idx` ON `ew_counts` (`as_of`);--> statement-breakpoint
CREATE TABLE `fills` (
	`id` text PRIMARY KEY NOT NULL,
	`client_order_id` text,
	`exchange_order_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`price` real NOT NULL,
	`size` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`role` text,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`time` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fills_time_idx` ON `fills` (`time`);--> statement-breakpoint
CREATE TABLE `funding` (
	`symbol` text NOT NULL,
	`time` integer NOT NULL,
	`rate_hourly` real NOT NULL,
	PRIMARY KEY(`symbol`, `time`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`singleton_key` text,
	`payload` text,
	`run_at` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`last_error` text,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`locked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_singleton_idx` ON `jobs` (`singleton_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_runat_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`review_after_trades` integer NOT NULL,
	`retired_at` integer,
	`retired_reason` text
);
--> statement-breakpoint
CREATE TABLE `llm_spend` (
	`day` text PRIMARY KEY NOT NULL,
	`usd` real DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `open_interest` (
	`symbol` text NOT NULL,
	`time` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`symbol`, `time`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`client_order_id` text PRIMARY KEY NOT NULL,
	`strategy_id` text,
	`exchange_order_id` text,
	`cycle_id` text,
	`proposal_id` text,
	`position_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`role` text NOT NULL,
	`size` real NOT NULL,
	`price` real,
	`stop_price` real,
	`status` text NOT NULL,
	`filled_size` real DEFAULT 0 NOT NULL,
	`avg_fill_price` real,
	`placed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_position_idx` ON `orders` (`position_id`);--> statement-breakpoint
CREATE TABLE `params_versions` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`params` text NOT NULL,
	`reason` text NOT NULL,
	`backtest` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_id` text,
	`proposal_id` text,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`size` real NOT NULL,
	`entry_price` real,
	`planned_entry` real,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`initial_stop` real NOT NULL,
	`leverage` real NOT NULL,
	`risk_usd` real NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer,
	`closed_at` integer,
	`exit_price` real,
	`exit_reason` text,
	`realized_pnl` real,
	`realized_r` real,
	`fees` real DEFAULT 0 NOT NULL,
	`funding_paid` real DEFAULT 0 NOT NULL,
	`mae` real,
	`mfe` real,
	`journal` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `positions_status_idx` ON `positions` (`status`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_id` text NOT NULL,
	`plan` text NOT NULL,
	`review` text,
	`risk` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`video_id` text PRIMARY KEY NOT NULL,
	`published_at` integer NOT NULL,
	`triage` text NOT NULL,
	`prior` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stages` (
	`cycle_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`input_hash` text,
	`output` text,
	`model` text,
	`usage` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	PRIMARY KEY(`cycle_id`, `stage`)
);
--> statement-breakpoint
CREATE TABLE `telegram_messages` (
	`key` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trade_reviews` (
	`position_id` text PRIMARY KEY NOT NULL,
	`review` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcripts` (
	`video_id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL,
	`segments` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`video_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`published_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`note` text
);
