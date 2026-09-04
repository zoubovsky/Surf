# ADR 0001: Host on a Hetzner Cloud VPS provisioned and deployed through GitHub Actions

Status: accepted (2026-09-04)

## Context
The operator has no existing server, wants the agent to do the infrastructure work, and wants secrets handled without pasting them into chat. The daemon must run 24/7, hold a WebSocket to Strike, poll Telegram, and spawn LLM calls. EU egress avoids Binance/Bybit geo-blocks on public market data.

## Decision
- One Hetzner Cloud server (CX32 class: 4 vCPU, 8 GB, Ubuntu 24.04, Nuremberg or Falkenstein).
- Provisioned by a GitHub Actions workflow using the `hcloud` CLI with a cloud-init script that installs Docker and registers a **self-hosted GitHub Actions runner** on the box.
- Deployed by a GitHub Actions workflow that runs *on that runner*: it receives repository secrets from GitHub, writes `/etc/surf/surf.env` (mode 0600), and runs `docker compose up -d`.
- An `ops` workflow (manual dispatch) lets the agent run diagnostics and read logs on the box without SSH.
- All secrets live in GitHub repository Actions secrets. The agent never sees them; the operator pastes them once into the GitHub UI.

## Consequences
- No SSH keys to manage; the runner is the only inbound path and it is outbound-only from the server.
- The operator must create a Hetzner account with a payment method and a fine-grained GitHub PAT (repo administration scope) so the runner can register.
- Backups: nightly SQLite `.backup` to a Hetzner volume; optional off-box copy later.
