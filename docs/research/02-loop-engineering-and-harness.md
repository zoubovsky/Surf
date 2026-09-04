# Loop Engineering and Harness Design for an Autonomous 1-Hour BTC Trading Agent

*Researched 2026-09-04. Based on the full PDF text of the linked paper, not secondary summaries.*

## Source access and provenance note

`https://asixiv.org/pdf/curated/2606.00001` (11 pages, ~9,700 words) was retrieved with a browser user-agent. **The PDF carries no author byline.** A footnote states it is "an independent reformatting of the author's open 'Orange Book' guide *Loop Engineering: Stop Asking Me What It Is* (v260615) into a conference-style document" (huasheng.ai/orange-books). The asixiv listing says "Submitted by ao12", subject `asi.RSI`, June 25, 2026. A mirror lists Steinberger, Cherny and Osmani as "authors"; the PDF presents them as the *sources* of the idea, not the authors. Treat it as a practitioner synthesis, not peer-reviewed research.

---

## 1. The loop-engineering paper

**Core thesis.** Loop engineering is "replacing oneself as the person who prompts the agent, and designing the system that does it instead" (Osmani, <https://addyosmani.com/blog/loop-engineering/>). The paper places it as a fourth layer: prompt (one exchange) → context (one window) → harness ("arming a single run: tools, actions, what counts as done") → loop ("scheduling on the harness: how to make it run itself over and over"). Three verbs separate loop from harness: runs on a timer, spawns helpers, feeds itself. Central economic claim: "loops make generation nearly free and leave judgment as the scarce resource."

The most important intuition: "the cost of a mistake scales with the number of turns it survives before someone catches it, and a loop is, by construction, a machine for maximizing the number of turns." A misreading "is written into the state file, read back the next morning as established fact, and built upon across many turns."

**Taxonomy: five moves of one turn, six parts.**

| Move | What it does | Realized by |
|---|---|---|
| Discovery | Find this turn's work on its own | Skills (SKILL.md) |
| Handoff | Hand the task off into isolation | Worktrees / sandboxes |
| Verification | "Swap in another agent to say no" | Sub-agents (generator/evaluator) |
| Persistence | Write state outside the conversation | Memory (disk state file, DB) |
| Scheduling | Make it turn round after round | Automations (cron, routines) |

Connectors (MCP) are the sixth part. "Memory is not context: context is what the agent sees this round and is flushed on refresh; memory persists across rounds and days."

**Independent reviewer/evaluator.** "Ask an agent to grade what it just produced and it tends to praise it confidently" because its context "is already stuffed with the reasons it was written that way." The fix is structural: "tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work." Three requirements: (1) a separate agent with different instructions, ideally a different model; (2) the evaluator should *act*, not just read (execute, run checks, judge behavior); (3) default stance of doubt: "assume the code is BROKEN until proven otherwise. DO NOT praise. Find what fails."

**"Continuous feedback loop."** The paper's term is "feeds itself": "what the loop produces becomes its own input next round; yesterday's findings are written to a file, and this morning it reads that file and carries on." The loop is closed by scheduling plus a persisted state file, with verification as the gate that decides what gets written back.

**Anti-patterns.** Nodding Loop (no verification: "a loop that has never once said 'no' to itself across hundreds of turns is proof that no real check exists"), Amnesiac Loop (no persistence), Manual Loop (no scheduling), Blind Loop (no discovery), Tangled Loop (no isolation). Four silent costs: verification debt, comprehension rot, cognitive surrender, token blowout.

**Design principles.** "Anything deterministic logic can solve never goes to a probabilistic model; where one draws that line decides whether the loop is reliable." Trigger a named skill, not a wall of instructions in a cron job. Read a sample every day. "Cap before you ship": per-run budget, daily budget, max retries as circuit breakers. "Keep one door open": at least one human checkpoint; "anything uncertain lands in ./inbox/."

**Evaluation results.** None quantitative; a field study of three cases (Osmani's triage loop; Stripe's "Minions" pipeline — secondhand; a cloud-vs-local scheduler comparison).

**Complementary formalization.** Macedo, "Stop Hand-Holding Your Coding Agent" (<https://arxiv.org/abs/2607.00038>) defines a *loop specification* = trigger + goal + verification + stopping rule + memory, and a five-level verification ladder: L1 deterministic (assertion, exit code), L2 rule/schema/policy, L3 delayed field truth ("true but slow"), L4 model-as-judge, L5 human checkpoint. Only L1–L2 is the "autonomous zone"; "do not pretend that level 4 is level 1." Terminal states must be named (success, no-op, blocked, stalled, exhausted); "an error or an exhausted budget never counts as success." Memory warning: "experience accumulated without governance can drive performance below the zero-shot baseline," so lessons must be curated, not appended.

---

## 2. Complementary harness-engineering guidance

- **Anthropic, "Building effective agents"** (<https://www.anthropic.com/engineering/building-effective-agents>): prefer workflows (predefined code paths) over open-ended agents where tasks are well-defined; evaluator-optimizer pattern works "when we have clear evaluation criteria"; add stopping conditions and human checkpoints; invest in tool design.
- **Anthropic, "Effective harnesses for long-running agents"** (<https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>): failure modes are doing everything at once and "prematurely declaring projects complete." Remedy: structured state on disk, a progress journal, one unit of work per session, self-verification with real tools.
- **Anthropic, "Effective context engineering"** (<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>): "find the smallest set of high-signal tokens"; compaction, structured note-taking, sub-agents that return condensed 1–2k-token summaries.
- **Anthropic, "Scaling managed agents"** (<https://www.anthropic.com/engineering/managed-agents>): decouple brain from hands; credentials never reach the sandbox where the model generates code.
- **Claude Agent SDK**: subagents with per-agent `model`, tool restrictions ("a reviewer that should never edit files gets `[Read, Grep, Glob]`"), `maxTurns`, `maxBudgetUsd`; hooks (`PreToolUse`, `Stop`, …) run deterministic code "before everything else in the permission chain" and can block operations. `/goal` = a fresh small model judges the stop condition after every turn.
- **Anthropic, "Getting started with loops"** (<https://claude.com/blog/getting-started-with-loops>): "Loops that write code need loops that check it"; "a reviewer with fresh context is less biased"; "match intervals to actual change frequency"; "run deterministic scripts rather than reasoning through repetitive steps."
- **OpenAI, "A practical guide to building agents"**: layer LLM-based and rules-based guardrails; rate each tool by "read-only vs. write access, reversibility, required permissions, and financial impact"; human intervention on high-stakes irreversible actions.
- **Trading-specific: "Agentic Trading: When LLM Agents Meet Financial Markets"** (<https://arxiv.org/html/2605.19337v1>): a deterministic state store "read-only to the LLM and updated solely by the environment"; an *outcome embargo* on episodic memory to prevent look-ahead leakage; chain-of-thought "is not guaranteed to be faithful"; only 1 of 19 closed-loop studies modeled transaction costs.

---

## 3. Design recommendations for a 1h BTC trading agent loop

### Loop cadences

| Loop | Trigger | Actor | Verifier level | Writes |
|---|---|---|---|---|
| **A. Signal ingestion** | Event: new YouTube video | LLM skill | L2 schema; reviewer L4 for claims | `signals` (thesis, direction, horizon, invalidation, confidence, source timestamp). Never orders. |
| **B. Decision** | Hourly candle close (+ finality delay) | Planner LLM → Reviewer LLM → deterministic risk engine → executor code | L4 hardened by separate model, then L1 gates | `decision_log`, orders, journal |
| **C. Position monitoring** | Every 1–5 min or exchange websocket | Code only | L1 | Stop/TP/kill-switch actions, alerts |
| **D. Post-trade review** | Event: position closed | Reviewer LLM (never the planner) | L3 field truth (realized P&L) + L4 | `trade_reviews`, calibration ledger |
| **E. Calibration & parameter update** | Weekly, or after N closed trades | Analyst proposes; backtest code judges; human door | L1 (walk-forward) then L5 | `strategy_params` (versioned) |

Loop A must not be allowed to trade. Its output is a persisted signal with a source timestamp, so Loop B can enforce that only information available before the candle close is used. Each hourly session starts fresh and reads state from disk.

### What the independent reviewer checks

Different model where possible, fresh context, read-only tools, no order-placement tool. Prompt: "Assume this trade plan is wrong until proven otherwise. Do not praise." Checklist:

1. **Data integrity**: candle is the closed candle, feed freshness within tolerance, no signal newer than decision time.
2. **Evidence chain**: every claim traces to a specific signal ID or indicator value; unsupported claims are a rejection.
3. **Consistency with state**: no contradiction with current params, regime flag, open positions, cooldown, or the last post-trade review's open lessons.
4. **Arithmetic recomputation**: recompute position size, stop distance and risk-per-trade from the plan's own inputs.
5. **Calibration sanity**: compare stated confidence to the historical hit rate of that confidence bucket.
6. **Structured verdict**: `{approve | revise | reject, reasons[], severity}`. Bounded revise loop (K rounds), then terminal `blocked`.

Track the reviewer's rejection rate. Never-rejects = Nodding Loop; always-rejects = broken the other way.

### Closing the feedback loop with realized outcomes

- **Journal at entry, not after**: thesis, signal IDs, expected move, invalidation, confidence, params version.
- **Deterministic outcome facts**: code computes realized R, MAE/MFE, holding time, slippage, fees. The LLM never computes P&L.
- **Post-trade review by the reviewer role**: classify decision quality vs. outcome, name the failure mode, propose at most one candidate lesson. Outcome embargo on retrieval.
- **Calibration ledger**: per confidence bucket, hit rate and Brier score; per signal source, realized edge after costs.
- **Parameter updates only through Loop E**: bounded change (one variable per turn); walk-forward backtest gate; lessons curated (kept or discarded on evidence after N trades).

### What stays deterministic code, never LLM judgment

- Candle-close detection, data validation, staleness checks, clock.
- Order sizing arithmetic, max position, max daily loss, max drawdown, per-trade risk cap, leverage cap.
- Stop-loss / take-profit / trailing logic and the kill switch (Loop C in its entirety).
- Idempotent order submission, duplicate suppression, exchange error handling, reconciliation against the exchange.
- Pre-trade checks as `PreToolUse` hooks on the order tool: reviewer-approved flag present, params version matches, cooldown respected, spread/slippage within bounds.
- Budget caps and named terminal states (`traded`, `no-op`, `blocked`, `stalled`, `exhausted`).
- Escalation: kill-switch trips, parameter changes, reviewer/planner deadlock → human inbox (Telegram).

Credentials live outside the model's reach. Measure cost per accepted trade decision, not raw token spend.

---

## Unverified or flagged items

- Authorship of the asixiv paper (see provenance note).
- Stripe "1,300 PRs/week" is secondhand even within the paper.
- Macedo's 50-loop statistics are from the arXiv text; the underlying corpus was not inspected.
- No source reports live P&L results for an LLM trading loop built this way; section 3 is a design translation, not evidence of profitability.
