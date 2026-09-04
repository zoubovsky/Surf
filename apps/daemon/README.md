# @surf/daemon

The single always-on process that wires the seven `@surf/*` libraries into the trading system from
`docs/00-game-plan.md`: SQLite (WAL) + Drizzle for state, a durable job runner for every loop, Strike
for execution, Telegram for the operator. `src/app.ts` (`buildApp(deps)`) constructs everything from
injectable dependencies (fetch, clock, LLM client, Strike REST, Telegram API, WebSocket factory,
transcript providers, EW analyzer); `src/main.ts` only passes real implementations and handles signals.

## Loop map

| Loop | Job kind (singleton key)                              | Handler                      | What it does                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —    | `market-refresh` (`market-refresh-<15m>`)             | `loops/market-refresh.ts`    | `MarketDataService.refresh()` (backfill on first run), persists funding/OI, records the Strike-vs-Coinbase cross-check as feed health.                                                                                                                |
| A    | `feed-poll` (`feed-poll-<5m>`)                        | `loops/feed-poll.ts`         | Polls the MCO long-form feed; new Bitcoin videos get a `video-ingest` job at T+10 min.                                                                                                                                                                |
| A    | `video-ingest` (`video-ingest-<id>[-<attempt>]`)      | `loops/video-ingest.ts`      | One transcript pass; on `pending` re-enqueues itself at 20/40/80/160 min and gives up 6h after detection. Then Haiku triage → Opus prior extraction → `signals` row → enqueues a `video-<id>` decision cycle (skipped if one ran in the last 15 min). |
| B    | `hourly-cycle` (`hourly-<ISO hour>` or `video-<id>`)  | `loops/decision.ts`          | Snapshots → EW engine → resting-order expiry → pre-gate (`loops/pregate.ts`) → research/analyze/review → risk engine → executor. Every stage is a `stages` row; re-running a cycle resumes from the checkpoints and never pays the LLM twice.         |
| C    | `monitor-tick` (`monitor-<minute>`, `monitor-ws-<t>`) | `loops/monitor.ts`           | Reconciles `positions` with the venue (or the shadow simulator): fills, exits with code-computed outcome, unknown positions → halt. Invalidation flatten, breakeven at +1R, equity/auto-halt, heartbeat, positions live-card.                         |
| D    | `post-trade-review` (`post-trade-<positionId>`)       | `loops/post-trade-review.ts` | `OutcomeFacts` from code → reviewer verdict → `trade_reviews`, at most one new `lessons` row; retires lessons whose trades since creation average R ≤ 0 once their review point passed.                                                               |
| —    | `daily-brief` (`daily-brief-<day>`)                   | `loops/daily-brief.ts`       | Sonnet prose (when a key exists) + code-rendered PnL / count / thesis / system sections; stored in kv for `/brief`.                                                                                                                                   |
| E    | `calibration` (`calibration-<day>`)                   | `loops/calibration.ts`       | Calibration table over closed trades, top-count relabeling rate, lesson curation. Parameter changes are disabled in v1 (no backtest gate yet).                                                                                                        |

Schedules live in `jobs/scheduler.ts`; the runner (`jobs/runner.ts`) is strictly sequential, retries with
backoff and dead-letters. A handler that throws sends a `warn` (retry) or `critical` (dead-lettered)
Telegram notice and never takes the process down.

## Execution

`execution/executor.ts` defines `Executor` (`placeBracket`, `cancelResting`, `flatten`, `moveStop`, `view`,
`account`, `fundingPaid`). `LiveExecutor` places Strike bracket orders (`POST /v2/order/strategy`, post-only
GTC limit or market entry, `take_profit` + `stop` legs on mark price, `setMarginMode(isolated)` while flat,
`setLeverage(ceil)`), flattens with a reduce-only market order + `cancelAll`, replaces the stop leg atomically
and refuses to widen a stop. `execution/shadow.ts` is the in-process simulator used in `TRADING_MODE=shadow`
(persisted in kv): maker fills on candle low/high or mark, stop-before-target on the same bar, 0.05% taker
exits, hourly funding accrual, equity in kv `shadow-equity` (default 10,000). Client order ids are
`surf-<positionId>-entry|sl|tp|exit`; `strategy_id` is `surf-<positionId>`.

## Environment

All variables are parsed by `packages/core/src/config.ts`; see `infra/surf.env.example`. The daemon adds
`RESTING_TTL_BARS` (default 12): resting entries are cancelled after that many hourly bars or when the
candidate that justified them disappears from the latest analysis. Without `ANTHROPIC_API_KEY` the LLM
stages report `blocked`; without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` every notice goes to the log;
without Strike keys the daemon runs on public data only (`live` mode refuses to start).

## Running

```sh
pnpm exec tsc -b                                  # build @surf/* dist
DATA_DIR=./data pnpm exec tsx apps/daemon/src/main.ts   # or: node apps/daemon/dist/main.js
curl -s 127.0.0.1:8787/health | jq                # ok, mode, halted, lastMonitor, jobs, feeds
```

Shutdown on SIGINT/SIGTERM stops schedules, drains the runner, stops the bot, closes the WebSocket,
flushes Telegram and closes the DB (hard exit after 9s).

## Tests

`pnpm exec vitest run apps/daemon`. Unit tests cover the pre-gate, live order payloads (exact Strike
bodies), the shadow simulator, monitor transitions with a fake exchange, PnL maths, the transcript retry
schedule and the decision cycle with a fake LLM (including checkpoint resume). `src/app.test.ts` runs
the whole daemon in memory (fake Strike/Coinbase/YouTube/LLM/Telegram, injected clock) from startup through
a shadow trade to the daily brief. Shared fakes live in `src/testing/` (excluded from the tsc build).
