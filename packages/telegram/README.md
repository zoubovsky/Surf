# @surf/telegram

Operator interface for the Surf daemon: a single allow-listed Telegram chat, HTML parse mode,
long polling. This package is a library; the daemon owns the process, the data and the wiring.

## Wiring

```ts
import { Api } from "grammy";
import { createBot, Notifier, formatDecision, formatExit, formatDailyBrief } from "@surf/telegram";
import type { TelegramPorts } from "@surf/telegram";

const ports: TelegramPorts = {/* getPnl, getPositions, ..., pause, resume, answerQuestion */};
const tg = createBot({
  token: config.TELEGRAM_BOT_TOKEN,
  allowedChatId: config.TELEGRAM_CHAT_ID,
  ports,
  logger,
});
await tg.start(); // setMyCommands + long polling; resolves once polling runs

const notifier = new Notifier({
  api: new Api(config.TELEGRAM_BOT_TOKEN),
  chatId: config.TELEGRAM_CHAT_ID,
  logger,
});
void notifier.notify("warn", formatDecision({ plan, review, risk, order })); // fire-and-forget is safe
void notifier.editOrSend("positions", formatPositions(view)); // live card, edited in place
await notifier.flush();
await tg.stop(); // on shutdown
```

## Pieces

- `ports.ts` — `TelegramPorts`, the only contract the daemon implements. Every method may be sync or
  async. `getBrief()` and `answerQuestion()` return HTML (Telegram subset: `b i u s code pre a`);
  `pause()`/`resume()` return plain text. Throwing is fine: the bot logs and replies generically.
- `types.ts` — Zod schemas for the report types (`PnlReport`, `OpenOrderView`, `StatusReport`,
  `TradeExplanation`, `FeedHealth`, ...). Core schemas are used by type only.
- `format.ts` — every message the operator sees: `formatPnl`, `formatPositions`, `formatOrders`,
  `formatCount`, `formatStatus`, `formatLimits`, `formatWhy`, `formatDecision`, `formatOrderPlaced`,
  `formatFill`, `formatStopMoved`, `formatExit`, `formatPrior`, `formatHalt`, `formatResumed`,
  `formatPaused`, `formatError`, `formatDailyBrief`; number helpers (`fmtPrice` 1 dp with thousands,
  `fmtSize` 5 dp, `fmtPct`/`fmtR` 2 dp); `escapeHtml` (only `< > &`), `truncate`, and
  `splitMessage(html, 4096)` which splits on newlines and re-opens/closes `<pre>` across chunks.
- `bot.ts` — `createBot({...})` → `{ bot, registerCommands, start, stop }`. The first middleware drops
  any update whose chat is not `allowedChatId` and notifies the operator once per foreign chat per
  UTC day. Commands: `/start /help /status /pnl /positions /orders /brief /why /count /limits /pause
/resume`; other text → `ports.answerQuestion`. `/pause` uses an inline keyboard whose
  `callback_data` carries a single-use nonce (5 min TTL, in memory); "Pause and flatten" asks again.
  Pending updates are dropped on start (`dropPendingUpdates: false` to replay them).
- `notifier.ts` — `Notifier` queue for pushes: one chat, sequential, ≥1s between calls, 429 retry
  honouring `retry_after`, exponential backoff on transport errors, no retry on other 4xx, plain-text
  fallback when Telegram rejects markup. `notify(level, html)` (`info` is silent) and
  `editOrSend(key, html)` for live cards. Resolves `boolean`, never rejects.

## Testing

No network: pass `botInfo` to skip `getMe`, `apiTransformer` to fake the Bot API, and drive the bot
with `tg.bot.handleUpdate(update)`. `Notifier` takes any `{ sendMessage, editMessageText }` plus
injectable `sleep`/`now`. See `src/__tests__/`.
