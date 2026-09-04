import { z } from "zod";
import { RiskLimits } from "./schemas/trading.js";

/** Process configuration from environment. Secrets are read here and nowhere else. */
export const AppConfig = z.object({
  TRADING_MODE: z.enum(["shadow", "live"]).default("shadow"),
  TZ: z.string().default("Europe/London"),
  DAILY_BRIEF_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("07:00"),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  SYMBOL: z.string().default("BTC-USD"),

  STRIKE_API_BASE: z.string().url().default("https://api.strikefinance.org"),
  STRIKE_WS_BASE: z.string().default("wss://api.strikefinance.org"),
  STRIKE_API_PUBLIC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  STRIKE_API_PRIVATE_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_TRIAGE: z.string().default("claude-haiku-4-5"),
  MODEL_RESEARCHER: z.string().default("claude-sonnet-5"),
  MODEL_ANALYST: z.string().default("claude-opus-5"),
  MODEL_REVIEWER: z.string().default("claude-opus-5"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.coerce.number().int().optional(),

  SUPADATA_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  COINALYZE_API_KEY: z.string().optional(),

  YOUTUBE_CHANNEL_ID: z.string().default("UCngIhBkikUe6e7tZTjpKK7Q"),
  YOUTUBE_LONGFORM_PLAYLIST: z.string().default("UULFngIhBkikUe6e7tZTjpKK7Q"),
  /** Videos older than this are not used as a prior. */
  PRIOR_MAX_AGE_HOURS: z.coerce.number().positive().default(48),
  /** Resting entry orders are cancelled if unfilled after this many hourly bars. */
  RESTING_TTL_BARS: z.coerce.number().int().positive().default(12),
});
export type AppConfig = z.infer<typeof AppConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: AppConfig; limits: RiskLimits } {
  const config = AppConfig.parse(env);
  const num = (k: string) => (env[k] === undefined || env[k] === "" ? undefined : Number(env[k]));
  const limits = RiskLimits.parse({
    riskPerTradePct: num("RISK_PER_TRADE_PCT"),
    maxLeverage: num("MAX_LEVERAGE"),
    maxDailyLossPct: num("MAX_DAILY_LOSS_PCT"),
    maxDrawdownPct: num("MAX_DRAWDOWN_PCT"),
    dailyLlmBudgetUsd: num("DAILY_LLM_BUDGET_USD"),
  });
  return { config, limits };
}
