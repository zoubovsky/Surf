import type { Logger } from "@surf/core";
import { escapeHtml } from "@surf/telegram";
import type { AppContext } from "../context.js";
import { schema } from "../db/index.js";
import { closedPositions, ewCountsSince, insertEvent } from "../db/queries.js";
import { formatCalibrationForPrompt, summarizeCalibration } from "../analytics/calibration.js";
import { toClosedTradeLite } from "../analytics/bridge.js";
import { retireStaleLessons } from "./post-trade-review.js";

export const RELABEL_WINDOW_BARS = 6;

/**
 * Count how often the top 1h candidate changed and how many of those tops lived fewer than
 * `RELABEL_WINDOW_BARS` cycles before being replaced (relabeling rate).
 */
export function relabelStats(rows: { asOf: number; analysis: { candidates: { id: string }[] } }[]): {
  cycles: number;
  switches: number;
  shortLived: number;
} {
  let switches = 0;
  let shortLived = 0;
  let currentId: string | null = null;
  let currentSince = 0;
  rows.forEach((r, i) => {
    const top = r.analysis.candidates[0]?.id ?? null;
    if (top === currentId) return;
    if (currentId !== null) {
      switches++;
      if (i - currentSince < RELABEL_WINDOW_BARS) shortLived++;
    }
    currentId = top;
    currentSince = i;
  });
  return { cycles: rows.length, switches, shortLived };
}

/**
 * Loop E (v1 scope): calibration report + lesson curation. Parameter change proposals are disabled
 * until a walk-forward backtest gate exists (ADR 0004 allows self-applying changes only behind it).
 */
export async function runCalibration(ctx: AppContext, log: Logger): Promise<unknown> {
  const now = ctx.now();
  const closed = closedPositions(ctx.db).filter((p) => p.realizedR !== null);
  const summary = summarizeCalibration(closed.map(toClosedTradeLite));
  const relabel = relabelStats(ewCountsSince(ctx.db, "1h", now - 7 * 86_400_000));
  const retired = retireStaleLessons(ctx, log);
  const active = ctx.db
    .select()
    .from(schema.lessons)
    .all()
    .filter((l) => l.status === "active").length;
  const report = [
    `📐 <b>Weekly calibration</b>`,
    `<pre>${escapeHtml(formatCalibrationForPrompt(summary))}</pre>`,
    `Top-count relabeling (7d): ${relabel.switches} switches over ${relabel.cycles} cycles, ${relabel.shortLived} lasted &lt; ${RELABEL_WINDOW_BARS} bars.`,
    `Lessons: ${active} active, ${retired.length} retired this run.`,
    `<i>Parameter change proposals are disabled in v1 (no backtest gate yet); limits unchanged.</i>`,
  ].join("\n");
  insertEvent(ctx.db, "info", "calibration", { totalTrades: summary.totalTrades, relabel, retired }, now);
  void ctx.notifier.notify("warn", report);
  return { totalTrades: summary.totalTrades, relabel, retired, paramsChanged: false };
}
