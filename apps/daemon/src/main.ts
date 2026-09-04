import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@surf/agents";
import { createLogger, loadConfig } from "@surf/core";
import { InnertubeProvider, supadataFromEnv, YtDlpProvider, type TranscriptProvider } from "@surf/ingestion";
import { Api } from "grammy";
import { buildApp } from "./app.js";
import { openDb } from "./db/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const { config, limits } = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const { db, close } = openDb({ path: `${config.DATA_DIR}/surf.sqlite` });
  const version = readVersion();

  const llmClient = config.ANTHROPIC_API_KEY ? createAnthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
  if (!llmClient) log.warn("ANTHROPIC_API_KEY not set: LLM stages will report blocked");
  const telegramApi = config.TELEGRAM_BOT_TOKEN ? new Api(config.TELEGRAM_BOT_TOKEN) : null;
  if (!telegramApi || config.TELEGRAM_CHAT_ID === undefined)
    log.warn("Telegram not configured: notifications go to the log");
  const transcriptProviders: TranscriptProvider[] = [];
  const supadata = supadataFromEnv(process.env);
  if (supadata) transcriptProviders.push(supadata);
  transcriptProviders.push(new InnertubeProvider(), new YtDlpProvider());

  const app = buildApp({ config, limits, db, log, version, llmClient, telegramApi, transcriptProviders });
  await app.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      log.error("graceful shutdown timed out; exiting");
      process.exit(1);
    }, 9_000);
    app
      .stop()
      .catch((err) => log.error({ err: String(err) }, "error during stop"))
      .finally(() => {
        clearTimeout(timer);
        close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err: String(err) }, "unhandled rejection"));
  process.on("uncaughtException", (err) => log.error({ err: String(err) }, "uncaught exception"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
