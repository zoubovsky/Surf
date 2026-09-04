# ADR 0003: Use the Anthropic TypeScript SDK (Messages API, tool runner, structured outputs) rather than the Claude Agent SDK

Status: accepted (2026-09-04)

## Context

Research proposed the Claude Agent SDK for analyst/researcher/reviewer. Every tool those agents need is one we define (market data reads, recompute helpers); none need the filesystem or Bash. The Agent SDK spawns a Claude Code subprocess per session (about 1 GiB each) and carries a moving bundled-CLI dependency.

## Decision

- `@anthropic-ai/sdk` with `client.messages.parse` for structured outputs and `client.beta.messages.toolRunner` with `betaZodTool` where a stage needs tools.
- Models: `claude-opus-5` for extractor, analyst and reviewer (reviewer uses a separate system prompt, fresh context, read-only tools); `claude-sonnet-5` for the researcher with the server-side `web_search_20260209` tool restricted to an allow-list; `claude-haiku-4-5` for triage.
- Adaptive thinking on all Claude 5 models; `output_config.effort` tuned per role.
- Every stage is a fresh request seeded from the database. No conversational state.
- Risk gates are ordinary code around the order-placement service; the LLM never holds an order tool.

## Consequences

- Lower memory, no subprocess, deterministic control flow, simpler deployment.
- We forgo Agent SDK hooks and subagents; we do not need them because tool execution is in our process.
- If the researcher later needs open-ended browsing, the server-side web fetch tool covers it.
