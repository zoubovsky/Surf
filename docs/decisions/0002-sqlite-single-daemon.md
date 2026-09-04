# ADR 0002: SQLite (WAL) with Drizzle, single daemon process, hand-rolled durable jobs

Status: accepted (2026-09-04)

## Context

Research recommended Postgres + pg-boss. The system is a single always-on process on one box; expected write volume is tiny (hundreds of rows a day). Postgres is not available in the development sandbox, which would leave the persistence layer untested until deploy.

## Decision

- SQLite in WAL mode via `better-sqlite3` and Drizzle ORM; migrations with drizzle-kit, applied at startup.
- A `jobs` table with singleton keys, attempts, backoff and dead-lettering, driven by `croner` for schedules. Every loop is a job handler with named terminal states.
- Per-stage checkpoints in a `stages` table so a crash between stages resumes without re-paying LLM calls.
- The MCP server (phase 6) is a second process reading the same file; WAL supports that at this volume.

## Consequences

- Fully testable here and in CI with a temp file database.
- Backups are file copies. If volume or multi-process writes grow, migrate to Postgres; Drizzle keeps the schema portable.
