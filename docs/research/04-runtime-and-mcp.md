# Runtime & Agent-Framework Layer — Research Report

_Researched 2026-09-04. Versions and prices were pulled live from the cited docs/registries._

## 0. Architecture in one paragraph

Run a **single always-on Node.js daemon** that owns three things: (1) a **trigger layer** (hourly cron at candle close + a YouTube feed watcher), (2) a **durable job queue** that turns each trigger into an idempotent "cycle" job, and (3) a **pipeline** of stages — cheap triage → analyst → market researcher → independent reviewer → deterministic risk engine → executor → Telegram. LLM stages run on the Claude Agent SDK (or the plain Messages API for one-shot classification); the risk engine and executor are plain code with no model in the loop. Every stage's inputs/outputs land in Postgres, which doubles as the job store and the audit journal. A thin MCP adapter later exposes the same core services to other agents.

---

## 1. Claude Agent SDK (TypeScript & Python), September 2026

**Packages and runtime.** `@anthropic-ai/claude-agent-sdk` 0.3.x (npm, Node ≥18) and `claude-agent-sdk` 0.2.x (PyPI, Python ≥3.10). Both bundle a native Claude Code binary; the SDK spawns a `claude` subprocess and talks over stdio, so one session = one subprocess; ~1 GiB RAM / 1 CPU per concurrent agent as a floor ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting)). Positioning: Agent SDK when you want the tool loop run for you; Client SDK (Messages API) when you implement the loop yourself; Managed Agents when Anthropic hosts ([overview](https://code.claude.com/docs/en/agent-sdk/overview)).

**Custom tools.** `tool(name, description, zodShape, handler, {annotations})` wrapped in `createSdkMcpServer({name, version, tools})`. Runs **in-process**; tools addressed as `mcp__{server}__{tool}` and pre-approved via `allowedTools`. `tools: []` strips all built-ins so the agent can only call your tools; `readOnlyHint: true` allows parallel calls; `isError: true` controls the error message the model reads ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)).

**Subagents.** `agents: { name: AgentDefinition }` with `description`, `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `permissionMode`. Fresh context per subagent; returns only its final message. Cap fan-out with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and `maxBudgetUsd` ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)).

**Hooks.** `PreToolUse` (return `permissionDecision: allow|deny|ask` and `updatedInput`), `PostToolUse`, `Stop`, `SubagentStart/Stop`, `PreCompact`, etc. ([hooks](https://code.claude.com/docs/en/agent-sdk/hooks)). Hooks run _first_ in the permission chain and a hook deny applies even under `bypassPermissions`. For a headless bot pair `allowedTools` with `permissionMode: "dontAsk"` so anything unlisted is denied rather than prompting ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions)).

**Structured outputs.** `outputFormat: { type: "json_schema", schema }` → validated JSON in `result.structured_output`; SDK re-prompts on mismatch. Schemas must be draft-07 ([structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)).

**Sessions.** Anthropic's explicit advice: _"Don't rely on session resume. Capture the results you need as application state and pass them into a fresh session's prompt"_ ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). For a trading loop that is exactly right: each cycle is a fresh `query()` seeded from Postgres, `persistSession: false`.

**Headless hygiene.** `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, explicit `cwd`, `maxTurns`, spread `...process.env` into `env` ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting)).

**Cost/latency.** Prompt caching is automatic with a 5-minute TTL by default; at an hourly cadence set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` and verify with `cache_read_input_tokens` ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).

**Current models and prices** ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), [models](https://platform.claude.com/docs/en/about-claude/models/overview)):

| Role                                         | Model ID           | In / Out per MTok | Cache read | Notes                                                       |
| -------------------------------------------- | ------------------ | ----------------- | ---------- | ----------------------------------------------------------- |
| Triage/filter (transcript relevance, dedupe) | `claude-haiku-4-5` | $1 / $5           | $0.10      | 200K ctx                                                    |
| Market researcher, risk narrative            | `claude-sonnet-5`  | $2 / $10          | $0.20      | 1M ctx, adaptive thinking                                   |
| Analyst, **independent reviewer**            | `claude-opus-5`    | $5 / $25          | $0.50      | "start here" default; effort `low`…`max`                    |
| Optional escalation for the reviewer         | `claude-fable-5-1` | $10 / $50         | $0.25      | Always-on thinking, slower; handle `stop_reason: "refusal"` |

Batch API is 50% off — useful for backtests, not live trading. Rough live-cost envelope: one hourly cycle with Haiku triage, Opus 5 analyst (~40K in mostly cached, 4K out), Sonnet 5 researcher and an Opus 5 reviewer lands around **$0.45–0.60**, i.e. ~$11–15/day for 24 cycles plus video-triggered runs. A deterministic pre-gate that skips the LLM stages on uneventful hours cuts this substantially.

Model-selection points: measure "the most capable model at lower effort" before building a cheap→expensive cascade; use a _different_ model (or at minimum a different prompt with no shared context) for the reviewer.

**Agent SDK vs Messages API.** Agent SDK where you want an agentic loop with web research, subagents, hooks and a spend cap (analyst, researcher, reviewer). Messages API (`client.messages.parse` with structured outputs) for triage — one shot, sub-second, no subprocess. Everything downstream of the reviewer (risk, execution) calls no model.

---

## 2. Orchestration & scheduling

| Option                    | Infra                                               | Strengths                                                                                                                                                                   | Weaknesses for a solo VPS                      |
| ------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **pg-boss** 12.x          | Postgres ≥13, Node ≥22.12                           | Cron, retries with backoff, singleton/dedupe keys, dead-letter queues, exactly-once via `SKIP LOCKED`; one DB for jobs + trades ([repo](https://github.com/timgit/pg-boss)) | No durable _step_ memoization (write your own) |
| BullMQ 6.x                | Redis                                               | Mature; Job Schedulers; custom `jobId` for idempotency                                                                                                                      | Adds Redis                                     |
| Inngest (self-hosted)     | Single binary                                       | Durable `step.run`/`step.sleep`; step memoization                                                                                                                           | No official support for self-hosted            |
| Trigger.dev (self-hosted) | Webapp + worker + Postgres + Redis + object storage | TypeScript-native durable tasks                                                                                                                                             | Heaviest footprint                             |
| Temporal                  | Multi-service cluster                               | Gold-standard durability                                                                                                                                                    | Ops burden disproportionate                    |

**Recommendation: pg-boss + hand-rolled stage checkpoints.**

- **Cycle identity.** `cycle_id = "btc-1h-2026-09-04T13:00Z"` or `"yt-<videoId>"`, used as the pg-boss `singletonKey` so a duplicate trigger cannot start a second run.
- **Stage table.** `stages(cycle_id, stage, status, input_hash, output jsonb, model, usage jsonb, cost_usd)`. The handler skips stages already `done`, so a crash between reviewer and executor resumes without re-paying the analyst.
- **Retries.** pg-boss `retryLimit`/`retryBackoff` for transient failures; LLM stages non-retryable after 2 attempts, then alert.
- **Triggers.** Hourly cron at `1 * * * *` (one-minute grace for candle finalization). YouTube: UULF RSS poll every 5 min (WebSub optional), dedupe on `videoId`.
- **Heartbeat** row each cycle for the dead-man's switch.

---

## 3. State, memory, feedback loop, secrets

**Database: Postgres 17 in Docker.** Core tables: `candles`, `signals`, `cycles`, `stages`, `proposals`, `reviews`, `risk_decisions`, `orders`/`fills`/`positions`, `journal` (append-only, one row per decision with `prompt_hash`, `knowledge_version`, `model`), `knowledge_versions`. Nightly `pg_dump`.

**Making the feedback loop safe and auditable.** The post-trade review agent must never _edit_ the live strategy knowledge directly:

1. It emits a **proposed diff** via structured output (`section`, `change`, `evidence_trade_ids`, `confidence`).
2. Deterministic checks: size cap, forbidden sections (risk limits and execution parameters are _not_ in that file), no URLs/instructions from untrusted sources.
3. The reviewer model scores the proposal.
4. Activation writes a new `knowledge_versions` row and commits to git; every `journal` row records the version, so P&L can be attributed to a knowledge version and rolled back.
5. Before activation, replay the last N cycles with the new knowledge and require no risk-rule breaches.

Treat YouTube transcripts as **untrusted input**: delimit them, tell the analyst they are data, never let transcript text flow into tool arguments unfiltered.

**Secrets for a self-hosted bot.**

- Strike uses an Ed25519 API wallet that cannot withdraw — hold that key, never a seed phrase, in the daemon.
- Inject secrets with **systemd credentials** (`LoadCredentialEncrypted=`) or a **sops + age**-encrypted env file decrypted at deploy.
- The model never sees credentials: `place_trade` is an in-process tool handler; the key lives in the process, not in any prompt.

---

## 4. MCP server design

**Spec revision 2026-07-28** removed protocol-level sessions and the `initialize` handshake (every request carries `_meta` protocol version + capabilities), made `server/discover` mandatory, replaced the GET stream with `subscriptions/listen`, moved tasks to an extension ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Servers needing cross-call state use "explicit, server-minted handles passed as ordinary tool arguments" — exactly how a `job_id` for a long `analyze_market` should work.

**TypeScript SDK v2.** `@modelcontextprotocol/server` 2.x (Node ≥20) with `/express`, `/node`, `/stdio` siblings; legacy `@modelcontextprotocol/sdk` 1.x remains for 2025-era clients ([v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html)).

```ts
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "surf", version: "1.0.0" });
  server.registerTool(
    "get_positions",
    { description: "Open positions and equity", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await positions.get()) }] }),
  );
  return server;
});
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ["mcp.example.com"] });
const node = toNodeHandler(handler);
app.all("/mcp", requireBearerAuth({ verifier }), (req, res) => void node(req, res, req.body));
```

**Authentication.** For a private single-operator server: `requireBearerAuth` with a long random pre-shared token, TLS via Caddy or a Tailscale interface, `express-rate-limit` per token. Note the Agent SDK's MCP client does not run OAuth flows; it needs a bearer token in `headers`.

**Tool surface and reuse.** Domain logic in plain services — `MarketAnalysis.analyze(cycle)`, `Proposals.propose(analysisId)`, `Execution.place(proposalId)`, `Positions.get()` — with Zod schemas shared across three adapters: Agent SDK `tool()` handlers, MCP `registerTool` handlers, Telegram commands. Rules: `analyze_market` returns a `job_id` and `get_analysis(job_id)` polls; `propose_trade` returns a proposal that has _already passed the risk engine_; `place_trade` accepts only a `proposal_id`, so no external agent can bypass risk controls; read tools marked `readOnlyHint: true`. Rate limits on `place_trade` are domain rules enforced in the core service.

---

## 5. Observability, evals, kill switch

**Log every prompt/response.** Agent SDK OTEL: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_RAW_API_BODIES=file:<dir>` writes untruncated request/response JSON to disk ([observability](https://code.claude.com/docs/en/agent-sdk/observability)). Independently persist structured outputs + usage in `stages` — the DB is the durable source of truth.

**Tracing backend.** Langfuse Cloud via OpenInference instrumentation if a UI is wanted; self-hosting Langfuse v3 (ClickHouse + Redis + MinIO) is too heavy for a small VPS.

**Replay and backtests.** Each stage stores exact inputs, so: (a) replay the risk engine + fill simulator against stored proposals for free; (b) re-run LLM stages over historical windows with the Batch API at 50% off. Caveat: Opus 5's knowledge cutoff is May 2026 and Sonnet 5's is January 2026 — backtests on earlier BTC history are contaminated by model memory of price action, so treat pre-cutoff backtests as smoke tests and trust forward/paper results.

**Kill switch: deterministic, outside the LLM.** Freqtrade's protections are prior art (StoplossGuard, MaxDrawdown):

- Max position size (% of equity), max daily loss, max drawdown from high-water mark, max orders/hour, max consecutive losses, minimum time between trades.
- Data-quality guards: stale candle, price deviation vs a second reference feed, exchange error circuit breaker.
- Global `trading_halted` flag in Postgres, set by `/halt` or automatically; **re-arming is manual only**.
- Startup reconciliation: fetch exchange positions/open orders before acting; refuse to trade on mismatch.
- Dead-man's switch: a cron in a _separate_ process alerts if no heartbeat in 2 cycles.
- Defense in depth: a `PreToolUse` hook denies `place_trade` unless a `risk_decision_id` with `verdict='allow'` exists for that proposal; `maxBudgetUsd` and `maxTurns` per cycle.

---

## 6. Recommended stack

| Layer            | Choice                                                                                                                   | Why                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Language/runtime | **TypeScript on Node 22 LTS**                                                                                            | pg-boss needs ≥22.12, MCP SDK v2 needs ≥20; TS Agent SDK has the fuller hook set; grammY and MCP are TS-native |
| Agent framework  | **Claude Agent SDK** for analyst/researcher/reviewer; **Messages API** for Haiku triage                                  | Loop, subagents, hooks and budgets without hand-rolling                                                        |
| Models           | Haiku 4.5 triage; Sonnet 5 researcher; Opus 5 analyst and reviewer (escalate reviewer to Fable 5.1 only if evals demand) | Cost/quality                                                                                                   |
| Queue/scheduler  | **pg-boss** with stage checkpoints                                                                                       | One datastore; exactly-once; cron + singleton keys                                                             |
| Database         | **Postgres 17** (Docker)                                                                                                 | Ledger, journal, queue in one place                                                                            |
| Telegram         | **grammY**, long polling                                                                                                 | No inbound port needed; whitelist one chat ID                                                                  |
| Hosting          | **VPS (e.g. Hetzner 4 vCPU / 8 GB, ~€15/mo)** with Docker Compose                                                        | Fixed price; Agent SDK subprocesses want ≥1 GiB each; EU egress avoids Binance/Bybit US blocks                 |
| Process manager  | **systemd** units (`Restart=always`, `LoadCredentialEncrypted=`); Caddy for TLS on `/mcp`                                | Native restarts and secrets                                                                                    |
| Observability    | OTEL env vars + raw API bodies to disk; Postgres journal; optional Langfuse Cloud                                        | Complete audit trail without a ClickHouse cluster                                                              |

**Trade-offs.** Agent SDK adds a subprocess and a moving dependency, but buys subagents, hooks, budgets and web tools. Postgres vs SQLite: SQLite + Litestream is simpler if you drop pg-boss. VPS vs PaaS: VPS is cheaper and predictable but you own patching and backups.

**Open questions.**

1. **MCP client compatibility:** whether the Agent SDK's `type: "http"` client already speaks 2026-07-28; SDK v2 handles both eras.
2. **Cache economics at hourly cadence:** measure `cache_read_input_tokens` with and without the 1h TTL.
3. **Reviewer independence:** same model family with different prompts vs Fable 5.1 — needs an eval set.
4. **Regulatory/tax logging** requirements in the operator's jurisdiction.
