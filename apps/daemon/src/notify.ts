import type { Logger } from "@surf/core";
import type { NotifyLevel } from "@surf/telegram";
import { stripHtml } from "@surf/telegram";
import { schema, type Db } from "./db/index.js";

/** The slice of `@surf/telegram`'s Notifier the daemon uses; `Notifier` satisfies it. */
export interface AppNotifier {
  notify(level: NotifyLevel, html: string): Promise<boolean>;
  editOrSend(key: string, html: string): Promise<boolean>;
  flush(): Promise<void>;
}

/** Used when no Telegram token is configured: every message goes to the log instead. */
export class LogNotifier implements AppNotifier {
  constructor(private readonly log: Logger) {}

  async notify(level: NotifyLevel, html: string): Promise<boolean> {
    const text = stripHtml(html);
    if (level === "critical") this.log.error({ telegram: level }, text);
    else if (level === "warn") this.log.warn({ telegram: level }, text);
    else this.log.info({ telegram: level }, text);
    return true;
  }

  async editOrSend(key: string, html: string): Promise<boolean> {
    this.log.debug({ telegram: "card", key }, stripHtml(html));
    return true;
  }

  async flush(): Promise<void> {}
}

/** Wraps a notifier and journals warn/critical notices into the `events` table for /why and audit. */
export class RecordingNotifier implements AppNotifier {
  constructor(
    private readonly inner: AppNotifier,
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  notify(level: NotifyLevel, html: string): Promise<boolean> {
    if (level !== "info") {
      try {
        this.db
          .insert(schema.events)
          .values({
            at: this.now(),
            level,
            kind: "telegram",
            payload: { text: stripHtml(html).slice(0, 2000) },
          })
          .run();
      } catch {
        /* never let journaling break a notification */
      }
    }
    return this.inner.notify(level, html);
  }

  editOrSend(key: string, html: string): Promise<boolean> {
    return this.inner.editOrSend(key, html);
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }
}
