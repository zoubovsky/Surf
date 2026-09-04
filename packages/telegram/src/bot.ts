import { randomBytes } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import type { Context, ErrorHandler, Transformer } from "grammy";
import type { BotCommand, UserFromGetMe } from "grammy/types";
import type { Clock, Logger } from "@surf/core";
import {
  escapeHtml,
  formatCount,
  formatLimits,
  formatOrders,
  formatPnl,
  formatPositions,
  formatStatus,
  formatUnauthorized,
  formatWhy,
  HELP_TEXT,
  splitMessage,
} from "./format.js";
import { isApiError, stripHtml } from "./notifier.js";
import type { TelegramPorts } from "./ports.js";
import { PnlRange } from "./types.js";

export interface CreateBotOptions {
  token: string;
  /** The single chat allowed to talk to the bot. Every other update is dropped. */
  allowedChatId: number;
  ports: TelegramPorts;
  logger: Logger;
  /** Provide to skip the network `getMe` on start (tests). */
  botInfo?: UserFromGetMe;
  /** grammY API transformer installed on `bot.api`; tests use it to fake Telegram. */
  apiTransformer?: Transformer;
  clock?: Clock;
  /** Lifetime of a /pause confirmation keyboard. Default 5 minutes. */
  nonceTtlMs?: number;
  /** Discard updates that queued up while the daemon was down. Default true. */
  dropPendingUpdates?: boolean;
}

export interface TelegramBot {
  /** The underlying grammY bot, for `handleUpdate` in tests or extra middleware. */
  bot: Bot;
  /** `setMyCommands` with the operator command list. Called by `start()`. */
  registerCommands(): Promise<void>;
  /** Register commands and begin long polling. Resolves once polling has started. */
  start(): Promise<void>;
  /** Stop polling and wait for the in-flight update to finish. */
  stop(): Promise<void>;
}

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: "status", description: "Heartbeat, feeds, last error, LLM spend" },
  { command: "pnl", description: "PnL: /pnl [today|7d|30d|all]" },
  { command: "positions", description: "Open positions" },
  { command: "orders", description: "Resting orders" },
  { command: "brief", description: "Latest research brief" },
  { command: "why", description: "Rationale for a trade: /why <id>" },
  { command: "count", description: "Current Elliott Wave candidates" },
  { command: "limits", description: "Hard risk limits (read-only)" },
  { command: "pause", description: "Stop new entries (optionally flatten)" },
  { command: "resume", description: "Re-enable new entries" },
  { command: "help", description: "List commands" },
];

type PauseAction = "entries" | "flatten" | "flatten-confirm" | "cancel";
const PAUSE_CALLBACK_RE = /^pause:(entries|flatten|flatten-confirm|cancel):([0-9a-f]{16})$/;

const PAUSE_PROMPT =
  "<b>Pause trading?</b>\nNew entries stop immediately; open positions and their stops keep being managed.";
const FLATTEN_PROMPT =
  "⚠️ <b>Pause and flatten</b>\nThis closes every open position at market and cancels resting orders. Are you sure?";

/** In-memory single-use nonces for inline keyboards. Each keyboard shares one nonce. */
class NonceStore {
  private readonly entries = new Map<string, { actions: ReadonlySet<PauseAction>; expiresAt: number }>();
  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
  ) {}

  issue(actions: readonly PauseAction[]): string {
    this.prune();
    const nonce = randomBytes(8).toString("hex");
    this.entries.set(nonce, { actions: new Set(actions), expiresAt: this.clock.now() + this.ttlMs });
    return nonce;
  }

  /** Consumes the nonce (whole keyboard) if it is live and permits `action`. */
  consume(nonce: string, action: PauseAction): boolean {
    this.prune();
    const entry = this.entries.get(nonce);
    if (!entry || !entry.actions.has(action)) return false;
    this.entries.delete(nonce);
    return true;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }
}

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

export function createBot(opts: CreateBotOptions): TelegramBot {
  const { token, allowedChatId, ports, logger } = opts;
  const clock = opts.clock ?? { now: () => Date.now() };
  const nonces = new NonceStore(clock, opts.nonceTtlMs ?? 5 * 60_000);
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  if (opts.apiTransformer) bot.api.config.use(opts.apiTransformer);

  /** Send HTML in chunks; if Telegram rejects the markup, resend that chunk as plain text. */
  async function replyHtml(ctx: Context, html: string): Promise<void> {
    for (const chunk of splitMessage(html)) {
      try {
        await ctx.reply(chunk, HTML);
      } catch (err) {
        if (!isApiError(err) || err.error_code !== 400) throw err;
        logger.warn({ err }, "telegram rejected HTML reply; resending as plain text");
        await ctx.reply(stripHtml(chunk), { link_preview_options: { is_disabled: true } });
      }
    }
  }

  // --- Allow-list: the very first middleware --------------------------------------------------
  const unauthorizedNotified = new Map<number, string>(); // chatId -> UTC day already notified
  async function onUnauthorized(chatId: number | undefined, username: string | undefined): Promise<void> {
    logger.warn({ chatId, username }, "dropped update from unauthorized chat");
    if (chatId === undefined) return;
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    if (unauthorizedNotified.get(chatId) === day) return;
    unauthorizedNotified.set(chatId, day);
    try {
      await bot.api.sendMessage(allowedChatId, formatUnauthorized(chatId, username, clock.now()), HTML);
    } catch (err) {
      logger.error({ err }, "failed to notify operator about unauthorized chat");
    }
  }

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    if (chatId === allowedChatId) return next();
    await onUnauthorized(chatId, ctx.from?.username);
  });

  // --- Error handling ---------------------------------------------------------------------------
  // `bot.catch` only sees errors from the polling loop; the boundary also covers `handleUpdate`
  // (tests, webhooks). Every handler below is registered on `app`, inside the boundary.
  const onError: ErrorHandler = async (err) => {
    logger.error({ err: err.error, updateId: err.ctx.update.update_id }, "telegram handler failed");
    try {
      await err.ctx.reply("Something went wrong handling that. Check the daemon logs.");
    } catch (replyErr) {
      logger.error({ err: replyErr }, "failed to send error reply");
    }
  };
  bot.catch(onError);
  const app = bot.errorBoundary(onError);

  // --- Commands ---------------------------------------------------------------------------------
  app.command(["start", "help"], async (ctx) => {
    const intro = ctx.hasCommand("start")
      ? `<b>Surf</b> operator bot connected to chat <code>${allowedChatId}</code>.\n\n`
      : "";
    await replyHtml(ctx, intro + HELP_TEXT);
  });

  app.command("status", async (ctx) => {
    const status = await ports.getStatus();
    await replyHtml(ctx, formatStatus(status, clock.now()));
  });

  app.command("pnl", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase() || "today";
    const range = PnlRange.safeParse(arg);
    if (!range.success) {
      await replyHtml(ctx, `Usage: /pnl [today|7d|30d|all] — got <code>${escapeHtml(arg)}</code>`);
      return;
    }
    await replyHtml(ctx, formatPnl(await ports.getPnl(range.data)));
  });

  app.command("positions", async (ctx) => {
    await replyHtml(ctx, formatPositions(await ports.getPositions(), clock.now()));
  });

  app.command("orders", async (ctx) => {
    await replyHtml(ctx, formatOrders(await ports.getOpenOrders()));
  });

  app.command("brief", async (ctx) => {
    const brief = await ports.getBrief();
    await replyHtml(ctx, brief.trim() || "No brief available yet.");
  });

  app.command("why", async (ctx) => {
    const id = ctx.match.trim().split(/\s+/)[0] ?? "";
    if (!id) {
      await replyHtml(ctx, "Usage: /why &lt;trade id&gt;");
      return;
    }
    const why = await ports.getWhy(id);
    await replyHtml(ctx, why ? formatWhy(why) : `No trade with id <code>${escapeHtml(id)}</code>.`);
  });

  app.command("count", async (ctx) => {
    const count = await ports.getCount();
    await replyHtml(ctx, count ? formatCount(count) : "No Elliott Wave analysis available yet.");
  });

  app.command("limits", async (ctx) => {
    await replyHtml(ctx, formatLimits(await ports.getLimits()));
  });

  app.command("resume", async (ctx) => {
    const msg = await ports.resume();
    await replyHtml(ctx, `▶️ <b>Resumed</b>\n${escapeHtml(msg)}`);
  });

  app.command("pause", async (ctx) => {
    const nonce = nonces.issue(["entries", "flatten", "cancel"]);
    const keyboard = new InlineKeyboard()
      .text("Pause new entries", `pause:entries:${nonce}`)
      .text("Pause and flatten", `pause:flatten:${nonce}`)
      .row()
      .text("Cancel", `pause:cancel:${nonce}`);
    await ctx.reply(PAUSE_PROMPT, { ...HTML, reply_markup: keyboard });
  });

  app.callbackQuery(PAUSE_CALLBACK_RE, async (ctx) => {
    const action = ctx.match[1] as PauseAction;
    const nonce = ctx.match[2] ?? "";
    const edit = (html: string, keyboard?: InlineKeyboard) =>
      ctx.editMessageText(html, keyboard ? { ...HTML, reply_markup: keyboard } : HTML);

    if (!nonces.consume(nonce, action)) {
      await ctx.answerCallbackQuery({ text: "This prompt has expired. Send /pause again." });
      await edit("Expired — send /pause again.");
      return;
    }
    switch (action) {
      case "cancel":
        await ctx.answerCallbackQuery({ text: "Cancelled" });
        await edit("Pause cancelled. Trading continues.");
        return;
      case "entries": {
        const msg = await ports.pause({ flatten: false });
        logger.info({ flatten: false }, "operator paused new entries");
        await ctx.answerCallbackQuery({ text: "Paused" });
        await edit(`⏸ <b>Paused new entries</b>\n${escapeHtml(msg)}`);
        return;
      }
      case "flatten": {
        const next = nonces.issue(["flatten-confirm", "cancel"]);
        await ctx.answerCallbackQuery();
        await edit(
          FLATTEN_PROMPT,
          new InlineKeyboard()
            .text("Yes, flatten everything", `pause:flatten-confirm:${next}`)
            .text("Cancel", `pause:cancel:${next}`),
        );
        return;
      }
      case "flatten-confirm": {
        const msg = await ports.pause({ flatten: true });
        logger.warn({ flatten: true }, "operator paused and flattened");
        await ctx.answerCallbackQuery({ text: "Flattening" });
        await edit(`⏸ <b>Paused and flattening</b>\n${escapeHtml(msg)}`);
        return;
      }
    }
  });

  // Any other callback (stale keyboards from older versions): acknowledge so the client stops spinning.
  app.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "This button is no longer active." });
  });

  // --- Free text -------------------------------------------------------------------------------
  app.on("message:text", async (ctx) => {
    const text = ctx.msg.text.trim();
    if (text.startsWith("/")) {
      await replyHtml(
        ctx,
        `Unknown command <code>${escapeHtml(text.split(/\s+/)[0] ?? "")}</code>. Try /help.`,
      );
      return;
    }
    await ctx.replyWithChatAction("typing");
    const answer = (await ports.answerQuestion(text)).trim();
    await replyHtml(ctx, answer || "I have no answer for that.");
  });

  // --- Lifecycle -------------------------------------------------------------------------------
  let polling: Promise<void> | null = null;

  async function registerCommands(): Promise<void> {
    await bot.api.setMyCommands(BOT_COMMANDS);
  }

  function start(): Promise<void> {
    if (polling) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let started = false;
      polling = bot
        .start({
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: opts.dropPendingUpdates ?? true,
          onStart: async (me) => {
            try {
              await registerCommands();
            } catch (err) {
              logger.error({ err }, "setMyCommands failed");
            }
            logger.info({ username: me.username, allowedChatId }, "telegram bot polling");
            started = true;
            resolve();
          },
        })
        .then(() => logger.info("telegram bot stopped"))
        .catch((err: unknown) => {
          logger.error({ err }, "telegram polling failed");
          if (!started) reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  async function stop(): Promise<void> {
    if (!polling) return;
    await bot.stop();
    await polling;
    polling = null;
  }

  return { bot, registerCommands, start, stop };
}
