# Operator setup: what you do, where each secret goes

Everything below is a one-time task for you. The agent does all provisioning and deployment from GitHub Actions; it never needs the secret values, only that they exist under these exact names.

**Do not paste any secret into chat.** Chat transcripts are stored. If you already have, rotate that secret after adding it here.

## 1. Where secrets go

GitHub → your `Surf` repository → **Settings → Secrets and variables → Actions → New repository secret**. Create each of these with the exact name:

| Secret name | What it is | Where you get it |
|---|---|---|
| `HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write) | Hetzner Cloud Console → your project → Security → API tokens → Generate. See §2. |
| `RUNNER_PAT` | GitHub fine-grained personal access token so the server can register itself as a self-hosted Actions runner | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → Generate. Resource owner: you. Repository access: only `Surf`. Repository permissions: **Administration: Read and write**. Expiry: 1 year. |
| `STRIKE_API_PUBLIC_KEY` | Your Strike API wallet public key (64 hex chars) | You already have it (app.strikefinance.org → API keys). |
| `STRIKE_API_PRIVATE_KEY` | Your Strike API wallet private key (64 hex chars, raw Ed25519 seed) | Same place. This key cannot withdraw funds. |
| `ANTHROPIC_API_KEY` | Anthropic API key | console.anthropic.com → API keys. Set a monthly spend limit there too (suggest $300). |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Telegram → @BotFather → `/newbot` → copy the token. |
| `TELEGRAM_CHAT_ID` | Your personal chat ID (a number) | Message @userinfobot on Telegram and it replies with your ID. Or send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `chat.id`. |
| `SUPADATA_API_KEY` | Transcript API key | supadata.ai → sign up → Basic plan ($5/mo) → API key. Optional at first; without it transcript retrieval falls back to slower paths. |

Optional later: `DEEPGRAM_API_KEY` (audio transcription fallback), `COINALYZE_API_KEY` (aggregate open interest), `FINNHUB_API_KEY` (news).

## 2. Hetzner account

1. Sign up at <https://console.hetzner.cloud>, add a payment method.
2. Create a project named `surf`.
3. In the project: Security → API tokens → Generate API token → permissions **Read & Write** → copy it into the `HCLOUD_TOKEN` secret above.

That is all. The `provision` workflow creates the server (CX32, Ubuntu 24.04, Nuremberg, about €15/month), a firewall that allows nothing inbound, and registers the runner. The `deploy` workflow then installs the daemon.

## 3. Telegram bot settings

After creating the bot with @BotFather, send it these so the bot stays private:

- `/setprivacy` → your bot → Enable (bot only sees commands in groups; we never add it to groups anyway).
- `/setinline` → leave disabled.
- `/setjoingroups` → your bot → Disable.

The daemon ignores every chat except `TELEGRAM_CHAT_ID` and alerts you if any other chat tries to talk to it.

## 4. Strike account preparation

- Deposit trading capital via the web app. Note the account is USD-margined.
- Set BTC-USD to **isolated margin** in the web app once (the daemon will also enforce it when flat).
- The daemon reads equity from the API; you do not configure capital anywhere.

## 5. What happens next

1. You add the secrets. Tell the agent "secrets are in".
2. The agent runs the `provision` workflow, waits for the runner to appear, then runs `deploy`.
3. The daemon starts in `TRADING_MODE=shadow`: it ingests data, runs the full decision loop, and posts to Telegram, but places no orders. The agent verifies connectivity, reconciliation and the order path (a tiny post-only limit order far from market, cancelled immediately) and then flips `TRADING_MODE=live` via the `deploy` workflow.
4. You will receive the first daily brief at the configured time (default 07:00 Europe/London; change `DAILY_BRIEF_TIME` and `TZ` in `infra/surf.env.example` if you want another).

## 6. Manual controls you have

Telegram: `/pause`, `/resume`, `/status`, `/pnl`, `/positions`, `/orders`, `/brief`, `/why <trade_id>`, `/count`, `/limits`.

GitHub Actions: the `deploy` workflow redeploys the current branch; the `ops` workflow shows logs and health without SSH. If you ever need to stop everything immediately, run `ops` with action `stop`, or power the server off in the Hetzner console. Open positions keep their exchange-side stop-loss and take-profit regardless.
