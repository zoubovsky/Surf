import type {
  AnalystPrior,
  EwAnalysis,
  EwCandidate,
  ReviewVerdict,
  RiskDecision,
  RiskLimits,
  SizedOrder,
  TradePlan,
} from "@surf/core";
import type {
  BriefSection,
  OpenOrderView,
  PnlReport,
  PositionsView,
  StatusReport,
  TradeExplanation,
} from "./types.js";

/** Telegram's hard limit on message text length. */
export const TELEGRAM_MAX_MESSAGE = 4096;

// ---------------------------------------------------------------------------
// Escaping and text helpers
// ---------------------------------------------------------------------------

/** Escape the three characters Telegram HTML parse mode requires. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Truncate a string to `max` characters, appending `suffix` when cut. */
export function truncate(text: string, max: number, suffix = "…"): string {
  if (text.length <= max) return text;
  if (max <= suffix.length) return suffix.slice(0, max);
  return text.slice(0, max - suffix.length) + suffix;
}

const b = (s: string) => `<b>${s}</b>`;
const code = (s: string) => `<code>${escapeHtml(s)}</code>`;
const pre = (s: string) => `<pre>${s}</pre>`;

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

const nf = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const PRICE = nf(1, 1);
const USD = nf(2, 2);
const SIZE = nf(5, 5);
const PCT = nf(2, 2);
const R = nf(2, 2);
const INT = nf(0, 0);

const na = "n/a";
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");

/** Price: thousands separators, 1 decimal. */
export const fmtPrice = (n: number | null | undefined): string => (n == null ? na : PRICE.format(n));
/** USD amount: signed, 2 decimals, e.g. "+$1,234.56". */
export const fmtUsd = (n: number | null | undefined): string =>
  n == null ? na : `${sign(n)}$${USD.format(Math.abs(n))}`;
/** Unsigned USD amount, e.g. "$1,234.56". */
export const fmtUsdAbs = (n: number | null | undefined): string => (n == null ? na : `$${USD.format(n)}`);
/** Position size: 5 decimals. */
export const fmtSize = (n: number | null | undefined): string => (n == null ? na : SIZE.format(n));
/** Percentage: signed, 2 decimals, e.g. "+1.25%". */
export const fmtPct = (n: number | null | undefined): string =>
  n == null ? na : `${sign(n)}${PCT.format(Math.abs(n))}%`;
/** Unsigned percentage (for limits and drawdown). */
export const fmtPctAbs = (n: number | null | undefined): string => (n == null ? na : `${PCT.format(n)}%`);
/** R multiple: signed, 2 decimals, e.g. "+1.50R". */
export const fmtR = (n: number | null | undefined): string =>
  n == null ? na : `${sign(n)}${R.format(Math.abs(n))}R`;
export const fmtInt = (n: number | null | undefined): string => (n == null ? na : INT.format(n));
export const fmtLeverage = (n: number | null | undefined): string =>
  n == null ? na : `${nf(0, 1).format(n)}x`;
/** Score 0..1 as two decimals. */
export const fmtScore = (n: number): string => R.format(n);

/** UTC timestamp, minute precision: "2026-09-04 16:51Z". */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return na;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return na;
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/** Human duration: "45s", "3m", "2h 05m", "1d 3h". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Age relative to `now`, e.g. "3m ago". */
export const fmtAge = (ms: number | null | undefined, now: number): string =>
  ms == null ? na : `${fmtDuration(now - ms)} ago`;

const dirArrow = (d: "long" | "short" | null | undefined) =>
  d === "long" ? "▲ LONG" : d === "short" ? "▼ SHORT" : "—";

const zone = (z: { low: number; high: number } | null | undefined) =>
  z ? `${fmtPrice(z.low)}–${fmtPrice(z.high)}` : na;

/** Two-column key/value table inside <pre>. Values are escaped. */
function kvTable(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return pre(rows.map(([k, v]) => `${k.padEnd(w)}  ${escapeHtml(v)}`).join("\n"));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function formatPnl(r: PnlReport): string {
  const label = r.range === "today" ? "today" : r.range === "all" ? "all time" : `last ${r.range}`;
  const rows: Array<[string, string]> = [
    ["Realized", fmtUsd(r.realizedUsd)],
    ["Unrealized", fmtUsd(r.unrealizedUsd)],
    ["Fees", fmtUsd(-Math.abs(r.feesUsd))],
    ["Funding", fmtUsd(r.fundingUsd)],
    ["Net", `${fmtUsd(r.netUsd)} (${fmtPct(r.netPct)})`],
    ["Equity", `${fmtUsdAbs(r.startEquity)} → ${fmtUsdAbs(r.endEquity)}`],
    ["Max DD", fmtPctAbs(r.maxDrawdownPct)],
    ["Trades", `${r.trades} (${r.wins}W / ${r.losses}L)`],
    ["Avg R", fmtR(r.avgR)],
    ["Best / Worst", `${fmtR(r.bestR)} / ${fmtR(r.worstR)}`],
  ];
  const parts = [`${b("PnL")} — ${escapeHtml(label)} · as of ${fmtTime(r.asOf)}`, kvTable(rows)];
  if (r.rows.length > 0) {
    const shown = r.rows.slice(0, 10);
    const lines = shown.map((t) => {
      const d = t.direction === "long" ? "L" : "S";
      const id = truncate(t.tradeId, 12).padEnd(12);
      return `${fmtTime(t.closedAt).slice(5, 16)} ${d} ${id} ${fmtUsd(t.realizedUsd).padStart(11)} ${fmtR(t.realizedR).padStart(7)}`;
    });
    const more = r.rows.length > shown.length ? `\n… ${r.rows.length - shown.length} more` : "";
    parts.push(`${b("Closed trades")}\n${pre(escapeHtml(lines.join("\n")) + more)}`);
  }
  return parts.join("\n");
}

export function formatPositions(view: PositionsView, now = Date.now()): string {
  const { account, market, orders } = view;
  const head = [
    `${b("Positions")} · ${escapeHtml(market.symbol)} mark ${fmtPrice(market.markPrice)}`,
    `Equity ${fmtUsdAbs(account.equity)} · Available ${fmtUsdAbs(account.availableBalance)}`,
    `Funding ${fmtPct(market.fundingRateHourly * 100)}/h · Updated ${fmtAge(account.asOf, now)}`,
  ];
  if (account.openPositions.length === 0) {
    return [...head, "", "No open positions."].join("\n");
  }
  const blocks = account.openPositions.map((p) => {
    const notional = p.size * p.entryPrice;
    const margin = notional / p.leverage;
    const roe = margin > 0 ? (p.unrealizedPnl / margin) * 100 : 0;
    const mine = orders.filter((o) => o.symbol === p.symbol);
    const stop = mine.find((o) => o.role === "stop-loss");
    const tp = mine.find((o) => o.role === "take-profit");
    const lines = [
      `${b(dirArrow(p.direction))} ${escapeHtml(p.symbol)} ${fmtSize(p.size)} @ ${fmtPrice(p.entryPrice)} · ${fmtLeverage(p.leverage)}`,
      `uPnL ${fmtUsd(p.unrealizedPnl)} (${fmtPct(roe)} on margin) · Notional ${fmtUsdAbs(notional)}`,
      `Stop ${fmtPrice(stop?.triggerPrice ?? stop?.price)} · TP ${fmtPrice(tp?.triggerPrice ?? tp?.price)} · Liq ${fmtPrice(p.liquidationPrice)}`,
    ];
    return lines.join("\n");
  });
  const resting = orders.filter((o) => o.role === "entry");
  const tail = resting.length > 0 ? [``, `${resting.length} resting entry order(s) — /orders`] : [];
  return [...head, "", ...blocks.flatMap((x, i) => (i === 0 ? [x] : ["", x])), ...tail].join("\n");
}

export function formatOrders(orders: OpenOrderView[]): string {
  if (orders.length === 0) return `${b("Open orders")}\n\nNo open orders.`;
  const lines = orders.map((o) => {
    const px = o.triggerPrice != null ? `trig ${fmtPrice(o.triggerPrice)}` : `@ ${fmtPrice(o.price)}`;
    const filled = o.filledSize > 0 ? ` (${fmtSize(o.filledSize)} filled)` : "";
    const trade = o.tradeId ? ` · trade ${o.tradeId}` : "";
    const ro = o.reduceOnly ? " · reduce-only" : "";
    return `• ${code(o.orderId)} ${o.role.toUpperCase()} ${o.side} ${fmtSize(o.size)} ${px}${filled}${ro}${escapeHtml(trade)} · ${escapeHtml(o.status)}`;
  });
  return [`${b("Open orders")} (${orders.length})`, "", ...lines].join("\n");
}

function formatCandidate(c: EwCandidate, rank: number): string {
  const target = c.targets[0];
  const lines = [
    `${rank}. ${b(escapeHtml(c.pattern))} ${dirArrow(c.direction)} · ${escapeHtml(c.position)} · score ${fmtScore(c.score)}`,
    `   Invalidation ${fmtPrice(c.invalidation.price)} — ${escapeHtml(c.invalidation.label)}`,
    `   Entry zone ${zone(c.entryZone)}${c.entryZone ? ` — ${escapeHtml(c.entryZone.label)}` : ""}`,
    `   Target ${zone(target)}${target ? ` — ${escapeHtml(target.label)}` : ""}`,
  ];
  if (c.notes[0]) lines.push(`   <i>${escapeHtml(truncate(c.notes[0], 160))}</i>`);
  lines.push(`   id ${code(c.id)}`);
  return lines.join("\n");
}

export function formatCount(a: EwAnalysis): string {
  const head = [
    `${b("EW count")} · ${escapeHtml(a.symbol)} ${escapeHtml(a.interval)} · close ${fmtPrice(a.lastClose)} · ${fmtTime(a.asOf)}`,
    `RSI14 ${a.momentum.rsi14 == null ? na : PCT.format(a.momentum.rsi14)} · divergence ${escapeHtml(a.momentum.rsiDivergence)} · ATR14 ${fmtPrice(a.momentum.atr14)} · ${a.swings.length} swings`,
  ];
  if (a.candidates.length === 0) return [...head, "", "No rule-valid count at the moment."].join("\n");
  const top = [...a.candidates].sort((x, y) => y.score - x.score).slice(0, 3);
  const more = a.candidates.length > 3 ? [``, `${a.candidates.length - 3} more candidate(s) not shown.`] : [];
  return [
    ...head,
    "",
    ...top.map((c, i) => formatCandidate(c, i + 1)).flatMap((x, i) => (i === 0 ? [x] : ["", x])),
    ...more,
  ].join("\n");
}

export function formatStatus(s: StatusReport, now = s.asOf): string {
  const state = s.halted ? "🔴 HALTED" : s.paused ? "⏸ PAUSED" : "🟢 RUNNING";
  const rows: Array<[string, string]> = [
    ["Mode", s.mode.toUpperCase()],
    ["State", state.replace(/^\S+ /, "")],
  ];
  if (s.halted) rows.push(["Halt reason", `${s.haltReason ?? "unknown"} (since ${fmtTime(s.haltedAt)})`]);
  rows.push(
    ["Uptime", fmtDuration(now - s.startedAt)],
    [
      "Last candle",
      s.lastCandleCloseTime == null
        ? na
        : `${fmtTime(s.lastCandleCloseTime)} (${fmtAge(s.lastCandleCloseTime, now)})`,
    ],
    [
      "Last cycle",
      s.lastCycleAt == null
        ? na
        : `${fmtAge(s.lastCycleAt, now)}${s.lastCycleTerminal ? ` → ${s.lastCycleTerminal}` : ""}`,
    ],
    ["Positions", `${s.openPositions} open · ${s.openOrders} orders`],
    ["Entries today", `${s.entriesToday} · stop-outs in a row: ${s.consecutiveStopOuts}`],
    ["LLM spend", `${fmtUsdAbs(s.llmSpendTodayUsd)} / ${fmtUsdAbs(s.llmBudgetUsd)} today`],
  );
  if (s.version) rows.push(["Version", s.version]);
  const feeds = s.feeds.map((f) => {
    const dot = f.health === "ok" ? "🟢" : f.health === "degraded" ? "🟡" : f.health === "down" ? "🔴" : "⚪";
    const detail = f.detail ? ` — ${escapeHtml(f.detail)}` : "";
    return `${dot} ${escapeHtml(f.name)}: ${f.health} · last ${fmtAge(f.lastEventAt, now)}${detail}`;
  });
  const parts = [`${b("Status")} ${state} · ${escapeHtml(s.symbol)} · ${fmtTime(s.asOf)}`, kvTable(rows)];
  if (feeds.length > 0) parts.push(`${b("Feeds")}\n${feeds.join("\n")}`);
  parts.push(
    s.lastError
      ? `${b("Last error")} ${fmtAge(s.lastError.at, now)} in ${code(s.lastError.context)}\n${code(truncate(s.lastError.message, 400))}`
      : "No errors recorded.",
  );
  return parts.join("\n");
}

export function formatLimits(l: RiskLimits): string {
  const rows: Array<[string, string]> = [
    ["Risk per trade", fmtPctAbs(l.riskPerTradePct)],
    ["Max leverage", fmtLeverage(l.maxLeverage)],
    ["Max positions", String(l.maxConcurrentPositions)],
    ["Max daily loss", fmtPctAbs(l.maxDailyLossPct)],
    ["Max drawdown", fmtPctAbs(l.maxDrawdownPct)],
    ["Max entries/day", String(l.maxEntriesPerDay)],
    ["Min gap between entries", `${l.minHoursBetweenEntries}h`],
    ["Max depth fraction", fmtPctAbs(l.maxDepthFraction * 100)],
    ["Min reward:risk", `${R.format(l.minRewardRisk)}:1`],
    ["Stop distance", `${fmtPctAbs(l.minStopDistancePct)} – ${fmtPctAbs(l.maxStopDistancePct)}`],
    ["Max candle age", fmtDuration(l.maxCandleAgeMs)],
    ["Max ref deviation", fmtPctAbs(l.maxReferenceDeviationPct)],
    ["Max consecutive stop-outs", String(l.maxConsecutiveStopOuts)],
    ["Halt cooldown", `${l.haltCooldownHours}h`],
    ["Daily LLM budget", fmtUsdAbs(l.dailyLlmBudgetUsd)],
    ["Min confidence", l.minConfidenceToTrade],
    ["Max adverse funding", `${fmtPctAbs(l.maxAdverseFundingHourly * 100)}/h`],
    ["Min notional", fmtUsdAbs(l.minNotionalUsd)],
    ["Size step / tick", `${l.sizeStep} / ${l.priceTick}`],
  ];
  return `${b("Hard limits")} (config only, read-only)\n${kvTable(rows)}`;
}

export function formatWhy(t: TradeExplanation): string {
  const status = t.closedAt == null ? "open" : `closed ${fmtTime(t.closedAt)}`;
  const lines = [
    `${b("Why")} ${code(t.tradeId)} · ${dirArrow(t.direction)} ${escapeHtml(t.symbol)} · ${status}`,
    `Setup ${escapeHtml(t.setup ?? na)} · candidate ${t.candidateId ? code(t.candidateId) : na} · prior ${t.priorVideoId ? code(t.priorVideoId) : "none"}`,
    `Entry ${fmtPrice(t.entryPrice)} · size ${fmtSize(t.size)} · ${fmtLeverage(t.leverage)} · SL ${fmtPrice(t.stopLoss)} · TP ${fmtPrice(t.takeProfit)}`,
  ];
  if (t.exitPrice != null || t.realizedUsd != null) {
    lines.push(`Exit ${fmtPrice(t.exitPrice)} · realized ${fmtUsd(t.realizedUsd)} (${fmtR(t.realizedR)})`);
  }
  lines.push(
    `Confidence ${t.confidence} · reviewer ${t.reviewVerdict}`,
    "",
    `${b("Rationale")}\n${escapeHtml(truncate(t.rationale, 1500))}`,
  );
  if (t.reviewReasons.length > 0) {
    lines.push(
      "",
      b("Reviewer"),
      ...t.reviewReasons.slice(0, 8).map((r) => `• ${escapeHtml(truncate(r, 300))}`),
    );
  }
  lines.push("", `${b("Risk")} ${escapeHtml(truncate(t.riskSummary, 300))}`);
  if (t.evidence.length > 0) {
    lines.push("", b("Evidence"), ...t.evidence.slice(0, 10).map((e) => `• ${escapeHtml(truncate(e, 200))}`));
  }
  if (t.events.length > 0) {
    lines.push(
      "",
      b("Timeline"),
      pre(
        escapeHtml(
          t.events
            .slice(-12)
            .map((e) => `${fmtTime(e.at)}  ${e.kind.padEnd(12)} ${truncate(e.detail, 60)}`)
            .join("\n"),
        ),
      ),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Decision cycle
// ---------------------------------------------------------------------------

export interface DecisionSummary {
  plan: TradePlan;
  review: ReviewVerdict;
  risk: RiskDecision;
  order: SizedOrder | null;
}

export function formatOrder(o: SizedOrder): string {
  return [
    `${dirArrow(o.direction)} ${escapeHtml(o.symbol)} ${o.entryKind} @ ${fmtPrice(o.entryPrice)}`,
    `Size ${fmtSize(o.size)} · notional ${fmtUsdAbs(o.notionalUsd)} · ${fmtLeverage(o.leverage)} · margin ${fmtUsdAbs(o.marginUsd)}`,
    `SL ${fmtPrice(o.stopLoss)} · TP ${fmtPrice(o.takeProfit)} · risk ${fmtUsdAbs(o.riskUsd)} · R:R ${R.format(o.rewardRisk)} · est. funding ${fmtUsd(o.expectedFundingUsd)}`,
  ].join("\n");
}

export function formatDecision({ plan, review, risk, order }: DecisionSummary): string {
  const action = plan.action.toUpperCase();
  const headline =
    plan.action === "enter"
      ? `${action} ${dirArrow(plan.direction)}${plan.setup ? ` · ${escapeHtml(plan.setup)}` : ""}`
      : plan.action === "adjust-stop"
        ? `${action} → ${fmtPrice(plan.newStop?.price)}`
        : action;
  const lines = [
    `${b("Decision")} ${headline} · ${risk.verdict === "allow" ? "✅ allowed" : "⛔ " + risk.terminal}`,
  ];

  const planLines: string[] = [];
  if (plan.entry) planLines.push(`Entry ${zone(plan.entry)} (${plan.entryKind ?? "?"})`);
  if (plan.stopLoss)
    planLines.push(`Stop ${fmtPrice(plan.stopLoss.price)} — ${escapeHtml(plan.stopLoss.label)}`);
  if (plan.takeProfit)
    planLines.push(`Target ${fmtPrice(plan.takeProfit.price)} — ${escapeHtml(plan.takeProfit.label)}`);
  planLines.push(
    `Confidence ${plan.confidence} · candidate ${plan.candidateId ? code(plan.candidateId) : na} · prior ${plan.priorVideoId ? code(plan.priorVideoId) : "none"}${plan.priorDisagrees ? " ⚠️ prior disagrees" : ""}`,
  );
  if (plan.expectedHoldHours != null) planLines.push(`Expected hold ~${plan.expectedHoldHours}h`);
  planLines.push(`<i>${escapeHtml(truncate(plan.rationale, 600))}</i>`);
  lines.push("", b("Analyst"), ...planLines);

  const rr = review.checks.rewardRiskRecomputed;
  lines.push(
    "",
    `${b("Reviewer")} ${review.verdict} · confidence ${review.adjustedConfidence} · severity ${review.severity}${rr == null ? "" : ` · R:R ${R.format(rr)}`}`,
    ...review.reasons.slice(0, 6).map((r) => `• ${escapeHtml(truncate(r, 300))}`),
  );

  const failed = risk.checks.filter((c) => !c.passed);
  lines.push("", `${b("Risk")} ${risk.verdict} · ${escapeHtml(risk.summary)}`);
  if (failed.length > 0)
    lines.push(...failed.slice(0, 6).map((c) => `✗ ${escapeHtml(c.rule)}: ${escapeHtml(c.detail)}`));
  else lines.push(`${risk.checks.length} checks passed`);

  if (order) lines.push("", b("Order"), formatOrder(order));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Trade events
// ---------------------------------------------------------------------------

export interface OrderPlacedEvent {
  tradeId: string;
  order: SizedOrder;
  mode: "shadow" | "live";
  orderId?: string;
}

export function formatOrderPlaced(e: OrderPlacedEvent): string {
  const tag = e.mode === "shadow" ? " (SHADOW)" : "";
  const id = e.orderId ? ` · order ${code(e.orderId)}` : "";
  return `${b("Order placed")}${tag} · trade ${code(e.tradeId)}${id}\n${formatOrder(e.order)}`;
}

export interface FillEvent {
  tradeId: string;
  symbol: string;
  direction: "long" | "short";
  role: "entry" | "stop-loss" | "take-profit" | "exit";
  price: number;
  size: number;
  at: number;
  feeUsd?: number;
  partial?: boolean;
}

export function formatFill(e: FillEvent): string {
  const label =
    e.role === "entry"
      ? "Entry filled"
      : e.role === "stop-loss"
        ? "Stop hit"
        : e.role === "take-profit"
          ? "Target hit"
          : "Exit filled";
  const partial = e.partial ? " (partial)" : "";
  const fee = e.feeUsd != null ? ` · fee ${fmtUsdAbs(e.feeUsd)}` : "";
  return `${b(label)}${partial} · trade ${code(e.tradeId)}\n${dirArrow(e.direction)} ${escapeHtml(e.symbol)} ${fmtSize(e.size)} @ ${fmtPrice(e.price)}${fee} · ${fmtTime(e.at)}`;
}

export interface StopMovedEvent {
  tradeId: string;
  symbol: string;
  from: number;
  to: number;
  reason: string;
  at: number;
}

export function formatStopMoved(e: StopMovedEvent): string {
  return `${b("Stop moved")} · trade ${code(e.tradeId)} · ${escapeHtml(e.symbol)}\n${fmtPrice(e.from)} → ${fmtPrice(e.to)} · ${escapeHtml(truncate(e.reason, 200))} · ${fmtTime(e.at)}`;
}

export interface ExitEvent {
  tradeId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  realizedUsd: number;
  realizedR: number | null;
  reason: string;
  openedAt: number;
  closedAt: number;
}

export function formatExit(e: ExitEvent): string {
  const win = e.realizedUsd >= 0 ? "✅" : "❌";
  return [
    `${b("Position closed")} ${win} · trade ${code(e.tradeId)}`,
    `${dirArrow(e.direction)} ${escapeHtml(e.symbol)} ${fmtSize(e.size)} · ${fmtPrice(e.entryPrice)} → ${fmtPrice(e.exitPrice)}`,
    `Realized ${fmtUsd(e.realizedUsd)} (${fmtR(e.realizedR)}) · held ${fmtDuration(e.closedAt - e.openedAt)} · ${escapeHtml(truncate(e.reason, 200))}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Video ingested, halts, errors, brief
// ---------------------------------------------------------------------------

export function formatPrior(p: AnalystPrior): string {
  const bias = p.bias ? dirArrow(p.bias) : "no bias";
  const lines = [
    `${b("Video ingested")} · ${escapeHtml(truncate(p.title, 120))}`,
    `${code(p.videoId)} · ${fmtTime(p.publishedAt)} · ${bias} · ${escapeHtml(p.timeframe)} · confidence ${p.confidence}`,
    "",
    `${b("Primary")} ${escapeHtml(truncate(p.primaryCount, 400))}`,
  ];
  if (p.alternateCount) lines.push(`${b("Alternate")} ${escapeHtml(truncate(p.alternateCount, 400))}`);
  lines.push(
    `${b("Invalidation")} ${p.invalidation ? `${fmtPrice(p.invalidation.price)} — ${escapeHtml(p.invalidation.label)}` : na}`,
  );
  if (p.entryZone) lines.push(`${b("Entry zone")} ${zone(p.entryZone)} — ${escapeHtml(p.entryZone.label)}`);
  if (p.targets.length > 0)
    lines.push(`${b("Targets")} ${p.targets.map((t) => fmtPrice(t.price)).join(", ")}`);
  if (p.keyLevels.length > 0) {
    lines.push(
      `${b("Key levels")} ${p.keyLevels
        .slice(0, 6)
        .map((l) => `${fmtPrice(l.price)} (${escapeHtml(l.label)})`)
        .join(", ")}`,
    );
  }
  lines.push("", `<i>${escapeHtml(truncate(p.summary, 800))}</i>`);
  return lines.join("\n");
}

export interface HaltNotice {
  reason: string;
  at: number;
  /** When the halt re-arms itself, if known. */
  resumesAt?: number | null;
  detail?: string;
}

export function formatHalt(h: HaltNotice): string {
  const lines = [`🔴 ${b("TRADING HALTED")} · ${fmtTime(h.at)}`, `Reason: ${escapeHtml(h.reason)}`];
  if (h.detail) lines.push(escapeHtml(truncate(h.detail, 400)));
  lines.push(
    h.resumesAt
      ? `Auto re-arm at ${fmtTime(h.resumesAt)} unless paused.`
      : "Open positions and stops are still managed. No new entries.",
  );
  return lines.join("\n");
}

export interface ResumeNotice {
  at: number;
  /** "operator" for /resume, "cooldown" for automatic re-arm. */
  by: "operator" | "cooldown";
  detail?: string;
}

export function formatResumed(r: ResumeNotice): string {
  const who = r.by === "operator" ? "by operator" : "after cooldown";
  const lines = [`🟢 ${b("Trading resumed")} ${who} · ${fmtTime(r.at)}`];
  if (r.detail) lines.push(escapeHtml(truncate(r.detail, 400)));
  return lines.join("\n");
}

export function formatPaused(opts: { flatten: boolean; at: number; detail?: string }): string {
  const lines = [
    `⏸ ${b(opts.flatten ? "Paused and flattening" : "Paused new entries")} · ${fmtTime(opts.at)}`,
  ];
  if (opts.detail) lines.push(escapeHtml(truncate(opts.detail, 400)));
  return lines.join("\n");
}

export interface ErrorNotice {
  context: string;
  message: string;
  at: number;
  /** e.g. "exhausted", "failed" */
  terminal?: string;
}

export function formatError(e: ErrorNotice): string {
  const t = e.terminal ? ` · ${escapeHtml(e.terminal)}` : "";
  return `⚠️ ${b("Error")} in ${code(e.context)}${t} · ${fmtTime(e.at)}\n${pre(escapeHtml(truncate(e.message, 1500)))}`;
}

export function formatUnauthorized(chatId: number, username: string | undefined, at: number): string {
  const who = username ? ` (@${escapeHtml(username)})` : "";
  return `⚠️ ${b("Ignored message from unauthorized chat")} ${code(String(chatId))}${who} · ${fmtTime(at)}`;
}

/** Daily brief scaffold: a dated header and one bold-titled block per section. Bodies are HTML. */
export function formatDailyBrief(sections: BriefSection[], date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const blocks = sections
    .filter((s) => s.body.trim().length > 0)
    .map((s) => `${b(escapeHtml(s.title))}\n${s.body.trim()}`);
  return [`📋 ${b(`Daily brief`)} · ${day}`, ...blocks].join("\n\n");
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

const PRE_OPEN = "<pre>";
const PRE_CLOSE = "</pre>";
const PRE_TAG_RE = /<pre(?:\s[^>]*)?>|<\/pre>/g;

/** Whether we are inside a <pre> block after processing `line`, given the state before it. */
function preStateAfter(line: string, inPre: boolean): boolean {
  let state = inPre;
  for (const m of line.matchAll(PRE_TAG_RE)) state = m[0] !== PRE_CLOSE;
  return state;
}

/**
 * Split HTML into chunks of at most `limit` characters. Splits only at newlines (hard-splits a
 * single over-long line as a last resort) and never leaves a `<pre>` block open: a chunk that
 * ends inside one gets `</pre>` appended and the next chunk re-opens with `<pre>`.
 */
export function splitMessage(html: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  let cur = "";
  let inPre = false;

  const isEmpty = () => cur === "" || cur === PRE_OPEN;
  const push = () => {
    if (!isEmpty()) chunks.push(inPre ? cur + PRE_CLOSE : cur);
    cur = inPre ? PRE_OPEN : "";
  };
  const fits = (line: string, after: boolean) =>
    cur.length + (isEmpty() ? 0 : 1) + line.length + (after ? PRE_CLOSE.length : 0) <= limit;
  const append = (line: string) => {
    cur += (isEmpty() ? "" : "\n") + line;
  };

  for (const line of html.split("\n")) {
    const after = preStateAfter(line, inPre);
    if (!fits(line, after)) push();
    if (fits(line, after)) {
      append(line);
      inPre = after;
      continue;
    }
    // A single line longer than the limit: hard-split it, tracking <pre> state per piece.
    const room = Math.max(1, limit - PRE_OPEN.length - PRE_CLOSE.length);
    for (let i = 0; i < line.length; i += room) {
      const piece = line.slice(i, i + room);
      const pieceAfter = preStateAfter(piece, inPre);
      if (!fits(piece, pieceAfter)) push();
      append(piece);
      inPre = pieceAfter;
      if (i + room < line.length) push();
    }
  }
  push();
  return chunks;
}

export const HELP_TEXT = [
  b("Commands"),
  `/status — heartbeat, feeds, last error, LLM spend`,
  `/pnl [today|7d|30d|all] — PnL table`,
  `/positions — open positions card`,
  `/orders — resting orders`,
  `/brief — latest research brief`,
  `/why &lt;trade id&gt; — stored rationale for a trade`,
  `/count — current Elliott Wave candidates`,
  `/limits — hard risk limits (read-only)`,
  `/pause — stop new entries (optionally flatten)`,
  `/resume — re-enable new entries`,
  ``,
  `Any other text is answered by the assistant with read-only access to the journal.`,
].join("\n");
