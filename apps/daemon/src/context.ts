import type { AppConfig, Candle, Clock, Logger, RiskLimits } from "@surf/core";
import type { LlmClient } from "@surf/agents";
import type { MultiResult } from "@surf/ew-engine";
import type { TranscriptChain } from "@surf/ingestion";
import type { MarketDataService } from "@surf/market-data";
import type { StrikeRestClient } from "@surf/strike";
import type { Db } from "./db/index.js";
import type { Executor } from "./execution/executor.js";
import type { JobRunner } from "./jobs/runner.js";
import type { AppNotifier } from "./notify.js";
import type { TradingStateStore } from "./state/trading-state.js";

export interface LlmModels {
  triage: string;
  researcher: string;
  analyst: string;
  reviewer: string;
}

export type FeedHealthState = "ok" | "degraded" | "down" | "unknown";

export interface FeedStatus {
  health: FeedHealthState;
  lastEventAt: number | null;
  detail: string | null;
}

export interface LastError {
  at: number;
  context: string;
  message: string;
}

/** Mutable, in-memory runtime health used by /status and /health. Not persisted. */
export class RuntimeHealth {
  readonly feeds = new Map<string, FeedStatus>();
  lastError: LastError | null = null;
  userStreamConnected = false;

  markFeed(
    name: string,
    health: FeedHealthState,
    detail: string | null = null,
    at: number | null = null,
  ): void {
    const prev = this.feeds.get(name);
    this.feeds.set(name, {
      health,
      lastEventAt: at ?? (health === "ok" ? (prev?.lastEventAt ?? null) : (prev?.lastEventAt ?? null)),
      detail,
    });
  }

  recordError(context: string, err: unknown, at: number): void {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.lastError = { at, context, message: message.slice(0, 500) };
  }
}

/** Pure EW analysis function; the daemon injects `analyzeMulti`, tests inject fixtures. */
export type EwAnalyzer = (input: { h1: readonly Candle[]; h4: readonly Candle[] }) => MultiResult;

/**
 * Everything a loop handler needs. Built once by `buildApp` and shared; every field is injectable
 * so the whole daemon can run in-memory under test.
 */
export interface AppContext {
  config: AppConfig;
  limits: RiskLimits;
  db: Db;
  log: Logger;
  clock: Clock;
  now(): number;
  runner: JobRunner;
  state: TradingStateStore;
  md: MarketDataService;
  rest: StrikeRestClient;
  executor: Executor;
  notifier: AppNotifier;
  llm: LlmClient | null;
  models: LlmModels;
  fetch: typeof fetch;
  analyzeEw: EwAnalyzer;
  transcripts: TranscriptChain | null;
  health: RuntimeHealth;
  version: string;
  startedAt: number;
  symbol: string;
}
