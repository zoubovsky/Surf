import type { Logger } from "@surf/core";
import { escapeHtml, splitMessage, TELEGRAM_MAX_MESSAGE } from "./format.js";
import type { NotifyLevel } from "./types.js";

export interface SendMessageOptions {
  parse_mode?: "HTML";
  disable_notification?: boolean;
  link_preview_options?: { is_disabled?: boolean };
}

/** The slice of grammY's `Api` the notifier uses. `new Api(token)` satisfies it; tests pass a fake. */
export interface NotifierApi {
  sendMessage(chatId: number, text: string, other?: SendMessageOptions): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: SendMessageOptions,
  ): Promise<unknown>;
}

export interface NotifierOptions {
  api: NotifierApi;
  chatId: number;
  logger: Logger;
  /** Minimum gap between API calls to the chat. Default 1000ms (Telegram: ~1 msg/s per chat). */
  minSpacingMs?: number;
  /** Attempts per API call before giving up. Default 5. */
  maxAttempts?: number;
  /** Cap on a single backoff wait. Default 30s. */
  maxBackoffMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Shape shared by grammY's `GrammyError` and any Bot API error payload. */
interface ApiErrorLike {
  error_code: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function isApiError(err: unknown): err is ApiErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { error_code?: unknown }).error_code === "number"
  );
}

const isNotModified = (err: unknown) =>
  isApiError(err) && /message is not modified/i.test(err.description ?? "");
const isParseError = (err: unknown) =>
  isApiError(err) && err.error_code === 400 && /can't parse entities|parse/i.test(err.description ?? "");
/** 400s that mean the message to edit is gone; the caller should send a fresh one. */
const isEditTargetGone = (err: unknown) =>
  isApiError(err) &&
  err.error_code === 400 &&
  /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err.description ?? "");

/** Best-effort HTML → plain text for the fallback path when Telegram rejects our markup. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Sequential outbound queue for one chat: ≥1s spacing, 429-aware retry with backoff, chunking
 * via `splitMessage`, and `editOrSend` for live-updated cards. Never rejects: delivery failures
 * are logged and reported through the returned boolean, so fire-and-forget callers are safe.
 */
export class Notifier {
  private readonly api: NotifierApi;
  private readonly chatId: number;
  private readonly logger: Logger;
  private readonly spacing: number;
  private readonly maxAttempts: number;
  private readonly maxBackoff: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private lastCallAt: number | null = null;
  private readonly messageIds = new Map<string, number>();

  constructor(opts: NotifierOptions) {
    this.api = opts.api;
    this.chatId = opts.chatId;
    this.logger = opts.logger;
    this.spacing = opts.minSpacingMs ?? 1000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Number of jobs queued or in flight. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Resolves when every queued job has finished. */
  async flush(): Promise<void> {
    await this.tail;
  }

  /** Send `html` (chunked if needed). `info` is silent; `warn` and `critical` ring. */
  notify(level: NotifyLevel, html: string): Promise<boolean> {
    return this.enqueue(async () => {
      let ok = true;
      for (const chunk of splitMessage(html)) {
        const sent = await this.sendChunk(chunk, { disable_notification: level === "info" });
        ok = ok && sent !== null;
      }
      return ok;
    });
  }

  /**
   * Keep one message per `key` (e.g. "positions") edited in place. Sends a new message when none
   * exists yet or the old one can no longer be edited. Over-long HTML is cut to the first chunk.
   */
  editOrSend(key: string, html: string): Promise<boolean> {
    return this.enqueue(async () => {
      const text = splitMessage(html, TELEGRAM_MAX_MESSAGE)[0] ?? "";
      const id = this.messageIds.get(key);
      if (id !== undefined) {
        try {
          await this.call(() => this.api.editMessageText(this.chatId, id, text, this.htmlOpts()));
          return true;
        } catch (err) {
          if (isNotModified(err)) return true;
          if (!isEditTargetGone(err)) {
            this.logger.error({ err, key }, "telegram edit failed");
            return false;
          }
          this.messageIds.delete(key);
        }
      }
      const sent = await this.sendChunk(text, { disable_notification: true });
      if (sent === null) return false;
      this.messageIds.set(key, sent);
      return true;
    });
  }

  /** Forget the tracked message for `key`, so the next `editOrSend` posts a fresh one. */
  reset(key: string): void {
    this.messageIds.delete(key);
  }

  private htmlOpts(extra: SendMessageOptions = {}): SendMessageOptions {
    return { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra };
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const run = this.tail.then(job, job).finally(() => {
      this.pendingCount--;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Returns the sent message id, or null when delivery ultimately failed. */
  private async sendChunk(text: string, extra: SendMessageOptions): Promise<number | null> {
    try {
      const res = await this.call(() => this.api.sendMessage(this.chatId, text, this.htmlOpts(extra)));
      return res.message_id;
    } catch (err) {
      if (isParseError(err)) {
        this.logger.warn({ err }, "telegram rejected HTML; resending as plain text");
        try {
          const res = await this.call(() => this.api.sendMessage(this.chatId, stripHtml(text), extra));
          return res.message_id;
        } catch (err2) {
          this.logger.error({ err: err2 }, "telegram plain-text fallback failed");
          return null;
        }
      }
      this.logger.error({ err }, "telegram send failed");
      return null;
    }
  }

  /** One API call with spacing, 429 handling and exponential backoff on transient failures. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await this.respectSpacing();
      try {
        const result = await fn();
        this.lastCallAt = this.now();
        return result;
      } catch (err) {
        this.lastCallAt = this.now();
        lastErr = err;
        const backoff = Math.min(this.maxBackoff, 1000 * 2 ** attempt);
        if (isApiError(err)) {
          if (err.error_code === 429) {
            const wait = err.parameters?.retry_after != null ? err.parameters.retry_after * 1000 : backoff;
            this.logger.warn({ attempt, wait }, "telegram rate limited (429)");
            await this.sleep(wait);
            continue;
          }
          if (err.error_code >= 400 && err.error_code < 500) throw err; // not retryable
        }
        this.logger.warn({ err, attempt }, "telegram call failed; retrying");
        await this.sleep(backoff);
      }
    }
    throw lastErr;
  }

  private async respectSpacing(): Promise<void> {
    if (this.lastCallAt === null) return;
    const wait = this.lastCallAt + this.spacing - this.now();
    if (wait > 0) await this.sleep(wait);
  }
}

/** Convenience: an unformatted, escaped one-liner. */
export const plain = (text: string): string => escapeHtml(text);
