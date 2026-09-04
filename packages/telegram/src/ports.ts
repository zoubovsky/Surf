import type { EwAnalysis, RiskLimits } from "@surf/core";
import type {
  OpenOrderView,
  PnlRange,
  PnlReport,
  PositionsView,
  StatusReport,
  TradeExplanation,
} from "./types.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Everything the bot needs from the daemon. The daemon implements this once and passes it to
 * `createBot`. Every method may be sync or async; the bot always awaits.
 *
 * Methods may throw: the bot logs the error and replies with a generic failure message.
 */
export interface TelegramPorts {
  /** Realized/unrealized PnL, fees, funding and closed trades for the range. */
  getPnl(range: PnlRange): MaybePromise<PnlReport>;
  /** Account + market snapshots plus resting orders, for the positions card. */
  getPositions(): MaybePromise<PositionsView>;
  /** All resting orders (entries, stops, take-profits). */
  getOpenOrders(): MaybePromise<OpenOrderView[]>;
  /** The latest research brief, already rendered as Telegram HTML. */
  getBrief(): MaybePromise<string>;
  /** Stored rationale for a trade, or null when the id is unknown. */
  getWhy(tradeId: string): MaybePromise<TradeExplanation | null>;
  /** Latest deterministic Elliott Wave analysis, or null before the first run. */
  getCount(): MaybePromise<EwAnalysis | null>;
  /** Heartbeat: mode, pause/halt, last candle, feed health, last error, LLM spend, uptime. */
  getStatus(): MaybePromise<StatusReport>;
  /** Read-only view of the hard risk limits. */
  getLimits(): MaybePromise<RiskLimits>;
  /** Stop new entries; with `flatten` also close every open position. Returns a human message. */
  pause(opts: { flatten: boolean }): MaybePromise<string>;
  /** Re-enable new entries. Returns a human message. */
  resume(): MaybePromise<string>;
  /** Free-text question from the operator, routed by the daemon to an LLM answerer. Plain text or HTML. */
  answerQuestion(text: string): MaybePromise<string>;
}
