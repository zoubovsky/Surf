# ADR 0005: TypeScript monorepo

Status: accepted (2026-09-04)

Node 22 LTS, pnpm workspaces, strict TypeScript, Vitest, Zod v4 schemas shared across the daemon, Telegram commands and the future MCP server. Packages: `core`, `strike`, `ew-engine`, `market-data`, `ingestion`, `agents`, `telegram`; apps: `daemon`, later `mcp-server`. Reason: the Anthropic SDK, grammY, Drizzle and the MCP SDK are all TypeScript-first, and one language keeps the shared schemas single-sourced.
