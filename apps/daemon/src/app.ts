import type { Server } from "node:http";
import type { AppConfig, Clock, Logger, RiskLimits } from "@surf/core";
import { systemClock } from "@surf/core";
import type { LlmClient } from "@surf/agents";
import { analyzeMulti } from "@surf/ew-engine";
import { FeedWatcher, TranscriptChain, type TranscriptProvider } from "@surf/ingestion";
import { MarketDataService, type MarketDataServiceOptions } from "@surf/market-data";
import {
  StrikeConfigError,
  StrikeRestClient,
  type StrikeUserStream,
  type WebSocketFactory,
} from "@surf/strike";
import {
  createBot,
  formatError,
  Notifier,
  type NotifierApi,
  type TelegramBot,
  type TelegramPorts,
} from "@surf/telegram";
import type { UserFromGetMe } from "grammy/types";
import { RuntimeHealth, type AppContext, type EwAnalyzer } from "./context.js";
import type { Db } from "./db/index.js";
import { kvGet } from "./db/index.js";
import { KV } from "./db/queries.js";
import { SqliteCandleRepository, SqliteSeenStore } from "./db/repos.js";
import type { Executor } from "./execution/executor.js";
import { LiveExecutor } from "./execution/executor.js";
import { ShadowExecutor } from "./execution/shadow.js";
import { startHealthServer } from "./health.js";
import { JobRunner } from "./jobs/runner.js";
import { startSchedules } from "./jobs/scheduler.js";
import { runCalibration } from "./loops/calibration.js";
import { runDailyBrief } from "./loops/daily-brief.js";
import { runDecisionCycle, type DecisionPayload } from "./loops/decision.js";
import { feedPoll } from "./loops/feed-poll.js";
import { marketRefresh } from "./loops/market-refresh.js";
import { monitorTick } from "./loops/monitor.js";
import { runPostTradeReview, type PostTradePayload } from "./loops/post-trade-review.js";
import { videoIngest, type VideoIngestPayload } from "./loops/video-ingest.js";
import { LogNotifier, RecordingNotifier, type AppNotifier } from "./notify.js";
import { runStartupChecks, type StartupReport } from "./startup.js";
import { TradingStateStore } from "./state/trading-state.js";
import { attachUserStream } from "./strike/user-stream.js";
import { createPorts } from "./telegram/ports.js";

export interface AppDeps {
  config: AppConfig;
  limits: RiskLimits;
  db: Db;
  log: Logger;
  version: string;
  clock?: Clock;
  fetch?: typeof fetch;
  /** Null when no ANTHROPIC_API_KEY: LLM stages report `blocked`. */
  llmClient: LlmClient | null;
  strikeRest?: StrikeRestClient;
  /** Telegram Bot API for pushes; null/undefined with no token means log-only. */
  telegramApi?: NotifierApi | null;
  /** grammY bot info to skip `getMe` (tests). */
  telegramBotInfo?: UserFromGetMe;
  webSocketFactory?: WebSocketFactory;
  transcriptProviders?: TranscriptProvider[];
  analyzeEw?: EwAnalyzer;
  /** Market-data overrides (tests shorten the backfill window). */
  marketData?: Partial<
    Pick<MarketDataServiceOptions, "coinbaseHistoryMs" | "strikeSince" | "maxDeviationPct">
  >;
  /** Port for the loopback health server; null disables it. Default 8787. */
  healthPort?: number | null;
  /** Start grammY long polling. Default true when a token is configured. */
  startBot?: boolean;
  sleep?: (ms: number) => Promise<void>;
  runnerPollMs?: number;
}

export interface App {
  ctx: AppContext;
  runner: JobRunner;
  ports: TelegramPorts;
  notifier: AppNotifier;
  executor: Executor;
  watcher: FeedWatcher;
  /** Startup checks + user stream + bot. Does not start schedules or the runner loop. */
  startup(): Promise<StartupReport>;
  /** startup() then schedules, runner loop and health server. */
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): { ok: boolean; details: Record<string, unknown> };
}

const HEALTH_STALE_MS = 3 * 60_000;

/** Wire every service from injectable dependencies. `main.ts` passes real implementations. */
export function buildApp(deps: AppDeps): App {
  const { config, limits, db, log, version } = deps;
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const fetchImpl = deps.fetch ?? fetch;
  const symbol = config.SYMBOL;
  const startedAt = now();
  const health = new RuntimeHealth();

  const hasStrikeCreds = !!config.STRIKE_API_PRIVATE_KEY;
  if (config.TRADING_MODE === "live" && !hasStrikeCreds) {
    throw new StrikeConfigError("TRADING_MODE=live requires STRIKE_API_PRIVATE_KEY (and public key)");
  }
  const rest =
    deps.strikeRest ??
    new StrikeRestClient({
      baseUrl: config.STRIKE_API_BASE,
      fetch: (url, init) => fetchImpl(url, init),
      clock,
      logger: log.child({ component: "strike" }),
      ...(hasStrikeCreds
        ? {
            credentials: {
              privateKey: config.STRIKE_API_PRIVATE_KEY!,
              publicKey: config.STRIKE_API_PUBLIC_KEY,
            },
          }
        : {}),
    });

  const runner = new JobRunner({ db, log, now, pollMs: deps.runnerPollMs ?? 1000 });
  const state = new TradingStateStore({
    db,
    log,
    limits,
    tradingMode: config.TRADING_MODE,
    tz: config.TZ,
    now,
  });
  const md = new MarketDataService({
    fetch: fetchImpl,
    clock,
    logger: log.child({ component: "market-data" }),
    repository: new SqliteCandleRepository(db),
    symbol,
    strikeBaseUrl: config.STRIKE_API_BASE,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...deps.marketData,
  });

  let notifier: AppNotifier;
  const telegramConfigured = !!config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID !== undefined;
  if (deps.telegramApi && config.TELEGRAM_CHAT_ID !== undefined) {
    notifier = new Notifier({
      api: deps.telegramApi,
      chatId: config.TELEGRAM_CHAT_ID,
      logger: log.child({ component: "telegram" }),
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  } else {
    if (telegramConfigured)
      log.warn("telegram token configured but no API instance injected; using log notifier");
    notifier = new LogNotifier(log.child({ component: "telegram" }));
  }
  notifier = new RecordingNotifier(notifier, db, now);

  const executor: Executor =
    config.TRADING_MODE === "live"
      ? new LiveExecutor({ rest, log, now })
      : new ShadowExecutor({ db, log, now, symbol });

  const transcripts =
    deps.transcriptProviders && deps.transcriptProviders.length > 0
      ? new TranscriptChain(deps.transcriptProviders, {
          clock,
          logger: log.child({ component: "transcripts" }),
        })
      : null;

  const ctx: AppContext = {
    config,
    limits,
    db,
    log,
    clock,
    now,
    runner,
    state,
    md,
    rest,
    executor,
    notifier,
    llm: deps.llmClient,
    models: {
      triage: config.MODEL_TRIAGE,
      researcher: config.MODEL_RESEARCHER,
      analyst: config.MODEL_ANALYST,
      reviewer: config.MODEL_REVIEWER,
    },
    fetch: fetchImpl,
    analyzeEw: deps.analyzeEw ?? ((input) => analyzeMulti(input)),
    transcripts,
    health,
    version,
    startedAt,
    symbol,
  };
  const ports = createPorts(ctx);

  const watcher = new FeedWatcher({
    fetch: (input, init) => fetchImpl(input, init),
    seen: new SqliteSeenStore(db, now),
    clock,
    logger: log.child({ component: "feed" }),
    playlistId: config.YOUTUBE_LONGFORM_PLAYLIST,
  });

  // ---- job handlers: throw to let the runner retry / dead-letter; critical notice on final failure.
  const guarded = (kind: string, fn: (payload: unknown, jobLog: Logger) => Promise<unknown>) => {
    runner.register(kind, async ({ job, log: jobLog }) => {
      try {
        return await fn(job.payload, jobLog);
      } catch (err) {
        health.recordError(kind, err, now());
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        const final = job.attempts >= job.maxAttempts;
        void notifier.notify(
          final ? "critical" : "warn",
          formatError({
            context: `${kind}${final ? " (dead-lettered)" : ` attempt ${job.attempts}/${job.maxAttempts}`}`,
            message,
            at: now(),
            terminal: "failed",
          }),
        );
        throw err;
      }
    });
  };
  guarded("market-refresh", (_p, l) => marketRefresh(ctx, l));
  guarded("feed-poll", (_p, l) => feedPoll(ctx, watcher, l));
  guarded("video-ingest", (p, l) => videoIngest(ctx, p as VideoIngestPayload, l));
  guarded("hourly-cycle", (p, l) => runDecisionCycle(ctx, p as DecisionPayload, l));
  guarded("monitor-tick", (_p, l) => monitorTick(ctx, l));
  guarded("post-trade-review", (p, l) => runPostTradeReview(ctx, p as PostTradePayload, l));
  guarded("daily-brief", (_p, l) => runDailyBrief(ctx, ports, l));
  guarded("calibration", (_p, l) => runCalibration(ctx, l));

  let schedules: { stop: () => void } | null = null;
  let healthServer: Server | null = null;
  let userStream: StrikeUserStream | null = null;
  let bot: TelegramBot | null = null;
  let started = false;

  const healthProvider = () => {
    const lastMonitor = kvGet<number>(db, KV.lastMonitor);
    const t = now();
    const monitorFresh =
      !started ||
      lastMonitor === null ||
      t - lastMonitor < HEALTH_STALE_MS ||
      t - startedAt < HEALTH_STALE_MS;
    const s = state.get();
    return {
      ok: monitorFresh,
      details: {
        version,
        mode: s.tradingMode,
        paused: s.paused,
        halted: s.halted,
        haltReason: s.haltReason,
        uptimeMs: t - startedAt,
        lastMonitor,
        lastCycle: kvGet(db, KV.lastCycle),
        jobs: runner.stats(),
        feeds: Object.fromEntries(health.feeds),
        lastError: health.lastError,
        userStream: health.userStreamConnected,
      },
    };
  };

  const startup = async (): Promise<StartupReport> => {
    runner.recoverOrphans();
    const report = await runStartupChecks(ctx, log.child({ component: "startup" }));
    if (config.TRADING_MODE === "live" && hasStrikeCreds) {
      userStream = attachUserStream(
        ctx,
        {
          privateKey: config.STRIKE_API_PRIVATE_KEY!,
          publicKey: config.STRIKE_API_PUBLIC_KEY,
          url: `${config.STRIKE_WS_BASE.replace(/\/+$/, "")}/ws/user-api`,
          webSocketFactory: deps.webSocketFactory,
        },
        log.child({ component: "strike-ws" }),
      );
    }
    const wantBot = deps.startBot ?? telegramConfigured;
    if (wantBot && config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID !== undefined) {
      bot = createBot({
        token: config.TELEGRAM_BOT_TOKEN,
        allowedChatId: config.TELEGRAM_CHAT_ID,
        ports,
        logger: log.child({ component: "telegram-bot" }),
        clock,
        ...(deps.telegramBotInfo ? { botInfo: deps.telegramBotInfo } : {}),
      });
      bot.start().catch((err) => log.error({ err: String(err) }, "telegram bot failed to start"));
    }
    return report;
  };

  const start = async (): Promise<void> => {
    await startup();
    started = true;
    schedules = startSchedules({ runner, log, tz: config.TZ, dailyBriefTime: config.DAILY_BRIEF_TIME, now });
    runner.start();
    // Kick the loops once right away instead of waiting for the next cron edge.
    runner.enqueue("market-refresh", { singletonKey: `market-refresh-boot-${startedAt}`, maxAttempts: 1 });
    runner.enqueue("monitor-tick", { singletonKey: `monitor-boot-${startedAt}`, maxAttempts: 1 });
    runner.enqueue("feed-poll", { singletonKey: `feed-poll-boot-${startedAt}`, maxAttempts: 1 });
    const port = deps.healthPort === undefined ? 8787 : deps.healthPort;
    if (port !== null) healthServer = startHealthServer(port, healthProvider, log);
    log.info(
      {
        mode: config.TRADING_MODE,
        symbol,
        version,
        telegram: telegramConfigured,
        llm: ctx.llm !== null,
        strikeCredentials: hasStrikeCreds,
      },
      "daemon started",
    );
  };

  const stop = async (): Promise<void> => {
    schedules?.stop();
    await runner.stop();
    if (bot) await bot.stop().catch(() => undefined);
    userStream?.close();
    await notifier.flush();
    if (healthServer) await new Promise<void>((r) => healthServer!.close(() => r()));
    log.info("daemon stopped");
  };

  return { ctx, runner, ports, notifier, executor, watcher, startup, start, stop, health: healthProvider };
}
