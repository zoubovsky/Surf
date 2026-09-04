import { GrammyError } from "grammy";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_COMMANDS, createBot } from "../bot.js";
import type { TelegramPorts } from "../ports.js";
import { account, ew, fakeLogger, limits, market, orders, pnl, status, T0, why } from "./fixtures.js";

const CHAT = 4242;
const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "surf",
  username: "surf_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function fakeApi() {
  const calls: Call[] = [];
  let nextId = 100;
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (method === "sendMessage") {
      if (p["parse_mode"] === "HTML" && String(p["text"]).includes("<bad>")) {
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          {
            ok: false,
            error_code: 400,
            description: 'Bad Request: can\'t parse entities: Unsupported start tag "bad"',
          },
          method,
          p,
        );
      }
      return {
        ok: true,
        result: {
          message_id: nextId++,
          date: 0,
          chat: { id: p["chat_id"], type: "private" },
          text: p["text"],
        },
      } as never;
    }
    if (method === "getUpdates") {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, result: [] } as never;
    }
    return { ok: true, result: true } as never;
  };
  const of = (method: string) => calls.filter((c) => c.method === method);
  return {
    calls,
    transformer,
    of,
    sent: () => of("sendMessage"),
    texts: () => of("sendMessage").map((c) => String(c.payload["text"])),
    lastText: () => String(of("sendMessage").at(-1)?.payload["text"] ?? ""),
  };
}

let uid = 0;
function textUpdate(text: string, chatId = CHAT, username = "operator"): Update {
  const cmd = text.match(/^\/\S+/)?.[0];
  const entities = cmd ? [{ type: "bot_command", offset: 0, length: cmd.length }] : [];
  return {
    update_id: ++uid,
    message: {
      message_id: uid,
      date: Math.floor(T0 / 1000),
      chat: { id: chatId, type: "private", first_name: "Op" },
      from: { id: chatId, is_bot: false, first_name: "Op", username },
      text,
      entities,
    },
  } as unknown as Update;
}

function callbackUpdate(data: string, chatId = CHAT, messageId = 7): Update {
  return {
    update_id: ++uid,
    callback_query: {
      id: `cq${uid}`,
      from: { id: chatId, is_bot: false, first_name: "Op", username: "operator" },
      chat_instance: "ci",
      data,
      message: {
        message_id: messageId,
        date: Math.floor(T0 / 1000),
        chat: { id: chatId, type: "private", first_name: "Op" },
        text: "prompt",
      },
    },
  } as unknown as Update;
}

function keyboardData(call: Call): string[] {
  const markup = call.payload["reply_markup"] as {
    inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
  };
  return markup.inline_keyboard.flat().map((b) => b.callback_data);
}

function makePorts(): { [K in keyof TelegramPorts]: ReturnType<typeof vi.fn> } & TelegramPorts {
  return {
    getPnl: vi.fn(async (range) => ({ ...pnl, range })),
    getPositions: vi.fn(async () => ({ account, market, orders })),
    getOpenOrders: vi.fn(async () => orders),
    getBrief: vi.fn(async () => "<b>Brief</b>\nall good"),
    getWhy: vi.fn(async (id: string) => (id === "t-001" ? why : null)),
    getCount: vi.fn(async () => ew),
    getStatus: vi.fn(async () => status),
    getLimits: vi.fn(async () => limits),
    pause: vi.fn(async (o: { flatten: boolean }) =>
      o.flatten ? "Paused; 1 position closed" : "Paused new entries",
    ),
    resume: vi.fn(async () => "Trading resumed"),
    answerQuestion: vi.fn(async (q: string) => `You asked: ${q}`),
  } as never;
}

function setup(opts: { nonceTtlMs?: number } = {}) {
  const api = fakeApi();
  const ports = makePorts();
  const logger = fakeLogger();
  let now = T0;
  const clock = { now: () => now };
  const tg = createBot({
    token: "000:fake",
    allowedChatId: CHAT,
    ports,
    logger,
    botInfo: BOT_INFO,
    apiTransformer: api.transformer,
    clock,
    ...(opts.nonceTtlMs !== undefined ? { nonceTtlMs: opts.nonceTtlMs } : {}),
  });
  const send = (u: Update) => tg.bot.handleUpdate(u);
  return { api, ports, logger, tg, send, advance: (ms: number) => (now += ms) };
}

describe("allow-list middleware", () => {
  it("drops foreign updates, calls no ports, and notifies the operator once per chat per day", async () => {
    const h = setup();
    await h.send(textUpdate("/status", 999, "intruder"));
    expect(h.ports.getStatus).not.toHaveBeenCalled();
    expect(h.api.sent()).toHaveLength(1);
    expect(h.api.sent()[0]!.payload["chat_id"]).toBe(CHAT);
    expect(h.api.lastText()).toContain("unauthorized chat");
    expect(h.api.lastText()).toContain("999");
    expect(h.api.lastText()).toContain("@intruder");
    expect(h.logger.warn).toHaveBeenCalled();

    await h.send(textUpdate("hello?", 999, "intruder"));
    await h.send(callbackUpdate("pause:cancel:0123456789abcdef", 999));
    expect(h.api.sent()).toHaveLength(1); // no repeat today

    await h.send(textUpdate("/status", 1000, "other"));
    expect(h.api.sent()).toHaveLength(2); // different chat → its own notice

    h.advance(24 * 3_600_000);
    await h.send(textUpdate("/status", 999, "intruder"));
    expect(h.api.sent()).toHaveLength(3); // new day → notified again
    expect(h.ports.getStatus).not.toHaveBeenCalled();
  });
});

describe("commands", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("/start and /help list commands", async () => {
    await h.send(textUpdate("/start"));
    expect(h.api.lastText()).toContain("connected to chat <code>4242</code>");
    expect(h.api.lastText()).toContain("<b>Commands</b>");
    await h.send(textUpdate("/help"));
    expect(h.api.lastText()).not.toContain("connected");
    expect(h.api.lastText()).toContain("/pause");
    expect(h.api.sent().at(-1)!.payload["parse_mode"]).toBe("HTML");
  });

  it("/status", async () => {
    await h.send(textUpdate("/status"));
    expect(h.ports.getStatus).toHaveBeenCalledOnce();
    expect(h.api.lastText()).toContain("RUNNING");
    expect(h.api.lastText()).toContain("strike-ws");
  });

  it("/pnl defaults to today, accepts ranges, rejects junk", async () => {
    await h.send(textUpdate("/pnl"));
    expect(h.ports.getPnl).toHaveBeenLastCalledWith("today");
    await h.send(textUpdate("/pnl 7d"));
    expect(h.ports.getPnl).toHaveBeenLastCalledWith("7d");
    expect(h.api.lastText()).toContain("last 7d");
    await h.send(textUpdate("/pnl ALL"));
    expect(h.ports.getPnl).toHaveBeenLastCalledWith("all");
    await h.send(textUpdate("/pnl yesterday"));
    expect(h.ports.getPnl).toHaveBeenCalledTimes(3);
    expect(h.api.lastText()).toContain("Usage: /pnl");
  });

  it("/positions and /orders", async () => {
    await h.send(textUpdate("/positions"));
    expect(h.ports.getPositions).toHaveBeenCalledOnce();
    expect(h.api.lastText()).toContain("▲ LONG");
    await h.send(textUpdate("/orders"));
    expect(h.api.lastText()).toContain("Open orders</b> (3)");
  });

  it("/brief passes through daemon HTML and chunks long output", async () => {
    await h.send(textUpdate("/brief"));
    expect(h.api.lastText()).toBe("<b>Brief</b>\nall good");
    h.ports.getBrief.mockResolvedValueOnce(Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n"));
    const before = h.api.sent().length;
    await h.send(textUpdate("/brief"));
    expect(h.api.sent().length - before).toBeGreaterThan(1);
  });

  it("/why", async () => {
    await h.send(textUpdate("/why"));
    expect(h.api.lastText()).toContain("Usage: /why");
    await h.send(textUpdate("/why nope"));
    expect(h.ports.getWhy).toHaveBeenLastCalledWith("nope");
    expect(h.api.lastText()).toContain("No trade with id <code>nope</code>");
    await h.send(textUpdate("/why t-001 extra"));
    expect(h.ports.getWhy).toHaveBeenLastCalledWith("t-001");
    expect(h.api.lastText()).toContain("<b>Why</b> <code>t-001</code>");
  });

  it("/count with and without an analysis", async () => {
    await h.send(textUpdate("/count"));
    expect(h.api.lastText()).toContain("EW count");
    expect(h.api.lastText()).toContain("c-top");
    h.ports.getCount.mockResolvedValueOnce(null);
    await h.send(textUpdate("/count"));
    expect(h.api.lastText()).toContain("No Elliott Wave analysis");
  });

  it("/limits", async () => {
    await h.send(textUpdate("/limits"));
    expect(h.api.lastText()).toContain("Hard limits");
    expect(h.api.lastText()).toContain("Risk per trade");
  });

  it("/resume", async () => {
    await h.send(textUpdate("/resume"));
    expect(h.ports.resume).toHaveBeenCalledOnce();
    expect(h.api.lastText()).toContain("Trading resumed");
  });

  it("free text goes to answerQuestion with a typing indicator", async () => {
    await h.send(textUpdate("how did the last W4 long go?"));
    expect(h.ports.answerQuestion).toHaveBeenCalledWith("how did the last W4 long go?");
    expect(h.api.of("sendChatAction")).toHaveLength(1);
    expect(h.api.lastText()).toBe("You asked: how did the last W4 long go?");
  });

  it("unknown slash commands get a hint instead of the LLM", async () => {
    await h.send(textUpdate("/frobnicate now"));
    expect(h.ports.answerQuestion).not.toHaveBeenCalled();
    expect(h.api.lastText()).toContain("Unknown command <code>/frobnicate</code>");
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    h.ports.answerQuestion.mockResolvedValueOnce("<b>ok</b> <bad>");
    await h.send(textUpdate("q"));
    const sent = h.api.sent();
    expect(sent.at(-2)!.payload["parse_mode"]).toBe("HTML");
    expect(sent.at(-1)!.payload["parse_mode"]).toBeUndefined();
    expect(sent.at(-1)!.payload["text"]).toBe("ok ");
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("port failures are logged and answered with a generic message", async () => {
    h.ports.getStatus.mockRejectedValueOnce(new Error("db locked"));
    await h.send(textUpdate("/status"));
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.api.lastText()).toContain("Something went wrong");
  });

  it("registerCommands calls setMyCommands with the operator commands", async () => {
    await h.tg.registerCommands();
    const call = h.api.of("setMyCommands")[0]!;
    const cmds = (call.payload["commands"] as Array<{ command: string }>).map((c) => c.command);
    expect(cmds).toEqual(BOT_COMMANDS.map((c) => c.command));
    expect(cmds).toContain("pause");
    expect(cmds).toContain("pnl");
  });
});

describe("/pause flow", () => {
  it("offers three options with nonce-bearing callback data", async () => {
    const h = setup();
    await h.send(textUpdate("/pause"));
    const call = h.api.sent().at(-1)!;
    expect(String(call.payload["text"])).toContain("Pause trading?");
    const data = keyboardData(call);
    expect(data).toHaveLength(3);
    for (const d of data) {
      expect(d).toMatch(/^pause:(entries|flatten|cancel):[0-9a-f]{16}$/);
      expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    }
    const nonces = new Set(data.map((d) => d.split(":")[2]));
    expect(nonces.size).toBe(1);
    expect(h.ports.pause).not.toHaveBeenCalled();
  });

  it("'Pause new entries' pauses once; the nonce cannot be replayed", async () => {
    const h = setup();
    await h.send(textUpdate("/pause"));
    const entries = keyboardData(h.api.sent().at(-1)!).find((d) => d.startsWith("pause:entries:"))!;
    await h.send(callbackUpdate(entries));
    expect(h.ports.pause).toHaveBeenCalledWith({ flatten: false });
    expect(h.api.of("answerCallbackQuery")).toHaveLength(1);
    const edit = h.api.of("editMessageText").at(-1)!;
    expect(edit.payload["message_id"]).toBe(7);
    expect(String(edit.payload["text"])).toContain("Paused new entries");

    await h.send(callbackUpdate(entries));
    expect(h.ports.pause).toHaveBeenCalledTimes(1);
    expect(String(h.api.of("editMessageText").at(-1)!.payload["text"])).toContain("Expired");
  });

  it("consuming one button invalidates the whole keyboard", async () => {
    const h = setup();
    await h.send(textUpdate("/pause"));
    const data = keyboardData(h.api.sent().at(-1)!);
    await h.send(callbackUpdate(data.find((d) => d.includes(":cancel:"))!));
    expect(String(h.api.of("editMessageText").at(-1)!.payload["text"])).toContain("cancelled");
    await h.send(callbackUpdate(data.find((d) => d.includes(":entries:"))!));
    expect(h.ports.pause).not.toHaveBeenCalled();
    expect(String(h.api.of("editMessageText").at(-1)!.payload["text"])).toContain("Expired");
  });

  it("'Pause and flatten' requires a second confirmation", async () => {
    const h = setup();
    await h.send(textUpdate("/pause"));
    const flatten = keyboardData(h.api.sent().at(-1)!).find((d) => d.startsWith("pause:flatten:"))!;
    await h.send(callbackUpdate(flatten));
    expect(h.ports.pause).not.toHaveBeenCalled();
    const confirmEdit = h.api.of("editMessageText").at(-1)!;
    expect(String(confirmEdit.payload["text"])).toContain("Are you sure?");
    const confirmData = keyboardData(confirmEdit);
    expect(confirmData.some((d) => d.startsWith("pause:flatten-confirm:"))).toBe(true);
    expect(confirmData.every((d) => !d.includes(flatten.split(":")[2]!))).toBe(true); // fresh nonce

    // The original 'entries' button is dead now.
    await h.send(callbackUpdate(flatten.replace("flatten", "entries")));
    expect(h.ports.pause).not.toHaveBeenCalled();

    await h.send(callbackUpdate(confirmData.find((d) => d.startsWith("pause:flatten-confirm:"))!));
    expect(h.ports.pause).toHaveBeenCalledWith({ flatten: true });
    expect(String(h.api.of("editMessageText").at(-1)!.payload["text"])).toContain("1 position closed");
  });

  it("nonces expire after the TTL", async () => {
    const h = setup({ nonceTtlMs: 5 * 60_000 });
    await h.send(textUpdate("/pause"));
    const entries = keyboardData(h.api.sent().at(-1)!).find((d) => d.startsWith("pause:entries:"))!;
    h.advance(5 * 60_000 + 1);
    await h.send(callbackUpdate(entries));
    expect(h.ports.pause).not.toHaveBeenCalled();
    expect(String(h.api.of("answerCallbackQuery").at(-1)!.payload["text"])).toContain("expired");
    expect(String(h.api.of("editMessageText").at(-1)!.payload["text"])).toContain("Expired");
  });

  it("acknowledges unknown callback data without doing anything", async () => {
    const h = setup();
    await h.send(callbackUpdate("legacy:button"));
    expect(h.api.of("answerCallbackQuery")).toHaveLength(1);
    expect(h.api.of("editMessageText")).toHaveLength(0);
    expect(h.ports.pause).not.toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("start registers commands and polls; stop halts polling", async () => {
    const h = setup();
    await h.tg.start();
    expect(h.api.of("setMyCommands")).toHaveLength(1);
    expect(h.api.of("deleteWebhook")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.api.of("getUpdates").length).toBeGreaterThan(0);
    await h.tg.stop();
    expect(h.tg.bot.isRunning()).toBe(false);
    await h.tg.stop(); // idempotent
  });
});
