# Surf

Autonomous Bitcoin trading system on the 1-hour timeframe. Elliott Wave analysis seeded by the More Crypto Online YouTube channel, independently re-derived by a deterministic wave engine, debated by a loop-engineered multi-agent harness with an independent reviewer, executed on Strike Finance perpetuals with resting bracket orders, and reported through Telegram.

**Current status: build phase.** Packages for the exchange client, market data, Elliott Wave engine, ingestion, LLM stages and Telegram are implemented and tested; the daemon that wires them is being completed; nothing is deployed yet. Start with the game plan, then `docs/SETUP.md` for the operator steps.

## Documents

- [`docs/SETUP.md`](docs/SETUP.md) — operator setup: where each secret goes, Hetzner account, Telegram bot, what happens on first deploy.
- [`docs/decisions/`](docs/decisions/) — architecture decision records (hosting, SQLite, Anthropic SDK, autonomy and risk defaults, TypeScript).
- [`infra/README.md`](infra/README.md) — how provisioning and deployment work.

- [`docs/00-game-plan.md`](docs/00-game-plan.md) — architecture, strategy design, loops, agent roster, safety model, roadmap, and the open decisions.
- [`docs/research/01-strike-finance.md`](docs/research/01-strike-finance.md) — Strike Finance V2 API, auth, bracket orders, fees, funding, liquidation, data.
- [`docs/research/02-loop-engineering-and-harness.md`](docs/research/02-loop-engineering-and-harness.md) — the loop-engineering paper, harness guidance, and how they translate to a trading loop.
- [`docs/research/03-ingestion-telegram-data-elliott-wave.md`](docs/research/03-ingestion-telegram-data-elliott-wave.md) — YouTube detection and transcripts, Telegram bot design, market data sources, Elliott Wave automation.
- [`docs/research/04-runtime-and-mcp.md`](docs/research/04-runtime-and-mcp.md) — Claude Agent SDK, orchestration, state, secrets, MCP server, observability, kill switches.
- [`docs/research/strike-openapi/`](docs/research/strike-openapi/) — vendored Strike Finance OpenAPI specs (public docs, for client generation).

## Principles

1. Anything deterministic logic can decide never goes to a model: stops, sizing, leverage, limits, order submission, PnL.
2. Every trade plan is reviewed by a separate agent with fresh context and no order tool, whose default stance is that the plan is wrong.
3. Every decision is journaled with the evidence, model, prompt and parameter version it ran under, and every outcome feeds a calibration ledger.
4. Budgets and terminal states are named. An exhausted budget is never success.
5. Fully autonomous trading, bounded by hard limits no agent can change, with veto windows on self-modification.
