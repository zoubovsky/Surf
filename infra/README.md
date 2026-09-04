# Surf infrastructure

One Hetzner Cloud VPS, provisioned and operated entirely from GitHub Actions. No SSH. Secrets live only in GitHub Actions secrets and in `/etc/surf/surf.env` on the box (mode 0600). See `docs/decisions/0001-hosting-hetzner-via-github-actions.md` and `docs/SETUP.md` for the operator-side setup (account, secret names).

## Pieces

| Path                              | Role                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile` (repo root)          | Multi-stage image for `apps/daemon`: pnpm via corepack, `tsc -b`, in-place prod prune, slim runtime as `node` (uid 1000) with tzdata, ffmpeg and yt-dlp. `HEALTHCHECK` on `http://127.0.0.1:8787/health`. Entrypoint `node apps/daemon/dist/main.js`. |
| `.dockerignore` (repo root)       | Keeps node_modules, dist, data, docs, .git, infra out of the build context.                                                                                                                                                                           |
| `infra/docker-compose.yml`        | `daemon` (built from the repo, `restart: unless-stopped`, `env_file: /etc/surf/surf.env`, `/var/lib/surf/data:/data`, no ports, json-file log rotation, `mem_limit: 3g`) and `backup` (alpine + sqlite3 sidecar running `backup.sh`).                 |
| `infra/backup.sh`                 | Daily 03:00 UTC `sqlite3 .backup` of every `/data/*.sqlite` to `/data/backups/<name>-YYYY-MM-DD.sqlite`, prune > 14 days; `once` and `snapshot` modes used by the ops workflow.                                                                       |
| `infra/redact.sh`                 | `sed` filter that masks anything looking like a key/token before it reaches an Actions log.                                                                                                                                                           |
| `infra/surf.env.example`          | Every environment variable the daemon reads, with defaults and comments. The real file is rendered by `deploy.yml`.                                                                                                                                   |
| `infra/cloud-init.yaml`           | Ubuntu 24.04 user-data: Docker CE, user `surf`, directories, ufw deny-all inbound, unattended-upgrades, GitHub Actions runner `surf-prod` as a systemd service. Logs to `/var/log/surf-cloud-init.log`.                                               |
| `.github/workflows/ci.yml`        | push/PR: install, `tsc -b`, lint, test, prettier check.                                                                                                                                                                                               |
| `.github/workflows/provision.yml` | Manual: creates firewall `surf-fw` + server `surf-prod` with the rendered cloud-init, waits for the runner to come online. `destroy=true` + `confirm=DESTROY` tears everything down.                                                                  |
| `.github/workflows/deploy.yml`    | Manual, runs on the server: writes `/etc/surf/surf.env`, `docker compose up -d --build`, waits for health, prints redacted logs.                                                                                                                      |
| `.github/workflows/ops.yml`       | Manual, runs on the server: `logs`, `health`, `restart`, `stop`, `start`, `db-backup-now`, `sql`.                                                                                                                                                     |

### How they fit

```
GitHub Actions (hosted runner)                      Hetzner Cloud
┌─────────────────────────────┐   hcloud API        ┌──────────────────────────────────────────┐
│ provision.yml               │ ──────────────────► │ server surf-prod (cx32, ubuntu-24.04)    │
│  - firewall surf-fw         │   user-data         │  firewall surf-fw: no inbound rules      │
│  - server + cloud-init      │                     │  ufw: deny incoming                      │
│  - 1h runner reg. token     │                     │  ┌─ actions-runner (systemd, user surf)  │
└─────────────────────────────┘                     │  │   labels: self-hosted, surf-prod       │
                                                    │  │   outbound long-poll to GitHub only    │
GitHub Actions (self-hosted = the server itself)    │  └────────────────────────────────────────│
┌─────────────────────────────┐                     │  /etc/surf/surf.env  (0600 surf)         │
│ deploy.yml / ops.yml        │ ── run on box ────► │  docker compose:                         │
│  secrets → surf.env         │                     │    surf-daemon  (node, uid 1000, /data)  │
│  compose up --build         │                     │    surf-backup  (alpine+sqlite3, /data)  │
└─────────────────────────────┘                     │  /var/lib/surf/data  (sqlite, backups)   │
                                                    └──────────────────────────────────────────┘
```

The server never accepts an inbound connection. The runner polls GitHub; the daemon dials Strike, Telegram, Anthropic and YouTube. The health endpoint on port 8787 exists only inside the container network namespace.

## Order of operations

Prerequisites (operator, once): the secrets from `docs/SETUP.md` exist in the repo (`HCLOUD_TOKEN`, `RUNNER_PAT`, `STRIKE_API_PUBLIC_KEY`, `STRIKE_API_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SUPADATA_API_KEY`; optional `DEEPGRAM_API_KEY`, `COINALYZE_API_KEY`, `FINNHUB_API_KEY`). `RUNNER_PAT` must be a fine-grained PAT scoped to this repo with **Administration: Read and write** (that is the permission for the self-hosted runner endpoints).

1. **CI green** on the branch (`ci.yml` runs on push).
2. **Actions → provision → Run workflow** (defaults: `cx32`, `nbg1`, `ubuntu-24.04`). Takes 3–6 minutes. The step summary shows the IP and the runner status; it fails if the runner is not online within 15 minutes.
   - Hetzner e-mails the root password because no SSH key is injected. Keep it; it is only usable from the Hetzner web console (VNC), which bypasses both firewalls.
3. **Actions → deploy → Run workflow** with `trading_mode = shadow`. First run builds the image on the box (a few minutes). The step summary shows the health status and the last 50 log lines.
4. **Actions → ops → `health`** and `logs` to verify connectivity (Strike WS, Telegram, first cycle). Check Telegram for the startup message.
5. When ready, **deploy** again with `trading_mode = live`. Nothing else changes.

Non-secret settings (TZ, DAILY_BRIEF_TIME, LOG_LEVEL, MODEL_\*, risk limits, ...) are repository **variables** (Settings → Secrets and variables → Actions → Variables) with the same names as in `surf.env.example`; unset means default. Changing one is a `deploy`.

## Rotating a secret

1. Update the value under Settings → Secrets and variables → Actions.
2. Run **deploy** (same `trading_mode`). It rewrites `/etc/surf/surf.env` and recreates the container; the old value is gone from the box.
3. Revoke the old credential at the provider.

Rotating `RUNNER_PAT` needs no deploy: it is only used by `provision.yml` (minting a registration token, polling runners, deleting a runner). Rotating `HCLOUD_TOKEN` likewise.

## If the runner dies

Symptoms: `deploy`/`ops` sit in "Waiting for a runner" and the repo's Settings → Actions → Runners shows `surf-prod` offline.

- **Server up, runner down**: open the server in the Hetzner console (VNC, root password from the e-mail), then `systemctl status 'actions.runner.*'`, `journalctl -u 'actions.runner.*' -n 200`, `sudo -u surf /opt/actions-runner/run.sh --check`. `/var/log/surf-cloud-init.log` has the bootstrap log. To re-register: `cd /opt/actions-runner && ./svc.sh stop && ./svc.sh uninstall && sudo -u surf ./config.sh remove --token <remove-token> ; sudo -u surf ./config.sh --unattended --url https://github.com/zoubovsky/Surf --token <registration-token> --name surf-prod --labels surf-prod --replace && ./svc.sh install surf && ./svc.sh start` (mint the tokens from the repo's Runners page → "New self-hosted runner"). The daemon keeps running throughout; it does not depend on the runner.
- **Server gone or unrecoverable**: copy `/var/lib/surf/data/backups/` somewhere if you still can (console + `hcloud server`-attached volume, or temporarily allow SSH: add an inbound rule to `surf-fw` in the console and `ufw allow from <your-ip> to any port 22`). Then run **provision** with `destroy = true`, `confirm = DESTROY`, then **provision** again, then **deploy**. The new server starts with an empty database; the daemon reconciles open positions from Strike on startup.
- **Reboot**: from the Hetzner console. Docker (`restart: unless-stopped`, `live-restore`) and the runner service both start on boot.

## Emergency stop

`ops` → `stop` (stops only the daemon; exchange-side stop-loss/take-profit on open positions remain), or power the server off in the Hetzner console. `ops` → `start` or `deploy` brings it back.

## Backups

`surf-backup` takes an online copy of every `/data/*.sqlite` at 03:00 UTC (and once at each start), keeps 14 days in `/data/backups/`. `ops` → `db-backup-now` runs it immediately; `ops` → `sql` snapshots the database and runs a read-only query on the copy (never the live file), e.g. `SELECT * FROM journal ORDER BY id DESC LIMIT 20;`. Backups are on the same disk as the database; an off-box copy (Hetzner volume or object storage) is a follow-up.

Host cron alternative to the sidecar loop: `0 3 * * * cd /opt/actions-runner/_work/Surf/Surf && docker compose -f infra/docker-compose.yml exec -T backup sh /backup.sh once`.

## Costs

Hetzner bills hourly up to a monthly cap; a stopped server still costs the same, only deletion stops billing. Prices excl. VAT; add your local VAT (20 % in the UK). Verify current list prices in the Hetzner console before creating the server — they could not be fetched programmatically when this was written.

| Item                                                        | Approx. €/month (excl. VAT)        |
| ----------------------------------------------------------- | ---------------------------------- |
| `cx32` (4 shared vCPU, 8 GB RAM, 80 GB NVMe, 20 TB traffic) | ≈ 6.80                             |
| Primary IPv4 (required for outbound to IPv4-only APIs)      | 0.50                               |
| Firewall, IPv6, snapshots not used                          | 0                                  |
| **Server total**                                            | **≈ 7.30 (≈ 8.80 incl. 20 % VAT)** |

`docs/decisions/0001` budgeted "about €15/month"; the actual Hetzner list price is below that. Downsizing to `cx22` (2 vCPU / 4 GB, ≈ €3.80) is possible but leaves little headroom for the 3 GB daemon limit plus image builds. GitHub Actions minutes on the self-hosted runner are free; `provision.yml` and `ci.yml` use hosted minutes (free tier: 2,000 min/month on private repos). Everything else (Anthropic, Supadata, Deepgram) is metered by the daemon's own budget (`DAILY_LLM_BUDGET_USD`) and the provider dashboards.

## Assumptions about the daemon (written concurrently)

- Listens on `127.0.0.1:8787` (or `0.0.0.0:8787`) inside the container and answers `GET /health` with 200 when ready. The deploy waits up to 3 minutes for that.
- Writes only under `DATA_DIR=/data` (plus `/tmp`, which is a tmpfs). If it needs to write elsewhere, add a `tmpfs` entry in `docker-compose.yml`.
- Database file is `/data/surf.sqlite` (or any `*.sqlite` directly in `/data` — the backup script handles either). Drizzle migration SQL files, if shipped under `apps/daemon/drizzle/`, are kept in the image (only `src/`, `tsconfig*.json` and `*.tsbuildinfo` are stripped).
- Handles SIGTERM (compose gives it 10 s by default; raise `stop_grace_period` if it needs longer to flush).
