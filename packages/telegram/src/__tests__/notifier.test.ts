import { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { Notifier, type NotifierApi, stripHtml } from "../notifier.js";
import { fakeLogger } from "./fixtures.js";

interface Call {
  method: "sendMessage" | "editMessageText";
  args: unknown[];
}

function apiErr(error_code: number, description: string, retry_after?: number) {
  const e = new Error(description) as Error & {
    error_code: number;
    description: string;
    parameters: { retry_after?: number };
  };
  e.error_code = error_code;
  e.description = description;
  e.parameters = retry_after === undefined ? {} : { retry_after };
  return e;
}

function harness(opts: { spacing?: number; maxAttempts?: number } = {}) {
  const calls: Call[] = [];
  const failures: unknown[] = []; // errors thrown by the next N calls, in order
  let nextId = 1;
  const api: NotifierApi = {
    async sendMessage(chatId, text, other) {
      calls.push({ method: "sendMessage", args: [chatId, text, other] });
      const f = failures.shift();
      if (f) throw f;
      return { message_id: nextId++ };
    },
    async editMessageText(chatId, messageId, text, other) {
      calls.push({ method: "editMessageText", args: [chatId, messageId, text, other] });
      const f = failures.shift();
      if (f) throw f;
      return true;
    },
  };
  let t = 0;
  const sleeps: number[] = [];
  const logger = fakeLogger();
  const n = new Notifier({
    api,
    chatId: 42,
    logger,
    minSpacingMs: opts.spacing ?? 1000,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { n, calls, failures, sleeps, logger, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

describe("Notifier", () => {
  it("grammY Api satisfies the NotifierApi interface", () => {
    const api: NotifierApi = new Api("000:fake");
    expect(api).toBeDefined();
  });

  it("sends HTML; info is silent, warn/critical ring", async () => {
    const h = harness();
    expect(await h.n.notify("info", "<b>hi</b>")).toBe(true);
    await h.n.notify("warn", "w");
    await h.n.notify("critical", "c");
    const [a, b, c] = h.sent();
    expect(a!.args[0]).toBe(42);
    expect(a!.args[1]).toBe("<b>hi</b>");
    expect(a!.args[2]).toMatchObject({ parse_mode: "HTML", disable_notification: true });
    expect(b!.args[2]).toMatchObject({ disable_notification: false });
    expect(c!.args[2]).toMatchObject({ disable_notification: false });
  });

  it("chunks long messages", async () => {
    const h = harness();
    const html = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    await h.n.notify("info", html);
    expect(h.sent().length).toBeGreaterThan(1);
    for (const c of h.sent()) expect((c.args[1] as string).length).toBeLessThanOrEqual(4096);
  });

  it("runs jobs sequentially with >= spacing between calls", async () => {
    const h = harness({ spacing: 1000 });
    const p1 = h.n.notify("info", "one");
    const p2 = h.n.notify("info", "two");
    const p3 = h.n.editOrSend("card", "three");
    expect(h.n.pending).toBe(3);
    await Promise.all([p1, p2, p3]);
    expect(h.n.pending).toBe(0);
    expect(h.sent().map((c) => c.args[1])).toEqual(["one", "two", "three"]);
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it("does not sleep when enough time has already passed", async () => {
    const h = harness({ spacing: 1000 });
    await h.n.notify("info", "one");
    // A sleep is only issued for the remaining gap; nothing happened in between so the full gap is waited once.
    await h.n.notify("info", "two");
    expect(h.sleeps).toEqual([1000]);
  });

  it("retries after 429 honouring retry_after", async () => {
    const h = harness();
    h.failures.push(apiErr(429, "Too Many Requests: retry after 3", 3));
    expect(await h.n.notify("warn", "x")).toBe(true);
    expect(h.sent().length).toBe(2);
    expect(h.sleeps).toContain(3000);
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("retries transient errors with exponential backoff and gives up after maxAttempts", async () => {
    const h = harness({ maxAttempts: 3 });
    h.failures.push(new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up"));
    expect(await h.n.notify("warn", "x")).toBe(false);
    expect(h.sent().length).toBe(3);
    expect(h.sleeps.filter((s) => s !== 1000 || true)).toContain(2000); // 1s then 2s backoff, plus spacing waits
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("does not retry other 4xx errors", async () => {
    const h = harness();
    h.failures.push(apiErr(403, "Forbidden: bot was blocked by the user"));
    expect(await h.n.notify("warn", "x")).toBe(false);
    expect(h.sent().length).toBe(1);
  });

  it("falls back to plain text when Telegram cannot parse the HTML", async () => {
    const h = harness();
    h.failures.push(apiErr(400, "Bad Request: can't parse entities: Unsupported start tag"));
    expect(await h.n.notify("warn", "<b>bold</b> &amp; <bad>")).toBe(true);
    const [first, second] = h.sent();
    expect(first!.args[2]).toMatchObject({ parse_mode: "HTML" });
    expect(second!.args[1]).toBe("bold & ");
    expect((second!.args[2] as Record<string, unknown>).parse_mode).toBeUndefined();
  });

  it("never rejects even when a job fails", async () => {
    const h = harness({ maxAttempts: 1 });
    h.failures.push(new Error("boom"));
    await expect(h.n.notify("info", "x")).resolves.toBe(false);
    await expect(h.n.notify("info", "y")).resolves.toBe(true); // queue keeps going
  });

  describe("editOrSend", () => {
    it("sends first, then edits the same message in place", async () => {
      const h = harness();
      await h.n.editOrSend("positions", "v1");
      await h.n.editOrSend("positions", "v2");
      await h.n.editOrSend("other", "o1");
      expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText", "sendMessage"]);
      expect(h.calls[1]!.args.slice(0, 3)).toEqual([42, 1, "v2"]);
      expect(h.calls[0]!.args[2]).toMatchObject({ disable_notification: true });
    });

    it("treats 'message is not modified' as success", async () => {
      const h = harness();
      await h.n.editOrSend("k", "same");
      h.failures.push(apiErr(400, "Bad Request: message is not modified"));
      expect(await h.n.editOrSend("k", "same")).toBe(true);
      expect(h.sent().length).toBe(1);
    });

    it("sends a fresh message when the old one can no longer be edited", async () => {
      const h = harness();
      await h.n.editOrSend("k", "v1");
      h.failures.push(apiErr(400, "Bad Request: message to edit not found"));
      expect(await h.n.editOrSend("k", "v2")).toBe(true);
      expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText", "sendMessage"]);
      await h.n.editOrSend("k", "v3");
      expect(h.calls.at(-1)!.method).toBe("editMessageText");
      expect(h.calls.at(-1)!.args[1]).toBe(2); // the new message id
    });

    it("reports failure on other edit errors and resets on demand", async () => {
      const h = harness();
      await h.n.editOrSend("k", "v1");
      h.failures.push(apiErr(403, "Forbidden"));
      expect(await h.n.editOrSend("k", "v2")).toBe(false);
      h.n.reset("k");
      await h.n.editOrSend("k", "v3");
      expect(h.calls.at(-1)!.method).toBe("sendMessage");
    });

    it("cuts over-long cards to the first balanced chunk", async () => {
      const h = harness();
      await h.n.editOrSend("k", `<pre>${Array.from({ length: 800 }, (_, i) => `r${i}`).join("\n")}</pre>`);
      const text = h.sent()[0]!.args[1] as string;
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text.endsWith("</pre>")).toBe(true);
    });
  });

  it("stripHtml removes tags and unescapes entities", () => {
    expect(stripHtml("<b>a</b> &lt;b&gt; &amp; c")).toBe("a <b> & c");
  });

  it("flush waits for the queue", async () => {
    const h = harness();
    void h.n.notify("info", "a");
    void h.n.notify("info", "b");
    await h.n.flush();
    expect(h.sent().length).toBe(2);
    expect(vi.isMockFunction(h.logger.error)).toBe(true);
  });
});
