import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  fmtDuration,
  fmtPct,
  fmtPrice,
  fmtR,
  fmtSize,
  fmtTime,
  fmtUsd,
  formatCount,
  formatDailyBrief,
  formatDecision,
  formatError,
  formatExit,
  formatFill,
  formatHalt,
  formatLimits,
  formatOrderPlaced,
  formatOrders,
  formatPnl,
  formatPositions,
  formatPrior,
  formatResumed,
  formatStatus,
  formatStopMoved,
  formatWhy,
  splitMessage,
  truncate,
} from "../format.js";
import {
  account,
  ew,
  limits,
  market,
  order,
  orders,
  plan,
  pnl,
  prior,
  review,
  riskAllow,
  riskDeny,
  status,
  T0,
  why,
} from "./fixtures.js";

describe("escaping and text helpers", () => {
  it("escapes only < > &", () => {
    expect(escapeHtml(`a < b & "c" > 'd'`)).toBe(`a &lt; b &amp; "c" &gt; 'd'`);
  });
  it("truncates with an ellipsis", () => {
    expect(truncate("hello world", 20)).toBe("hello world");
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello", 1)).toBe("…");
  });
});

describe("number formatting", () => {
  it("prices: thousands separators, 1 decimal", () => {
    expect(fmtPrice(112345.678)).toBe("112,345.7");
    expect(fmtPrice(5)).toBe("5.0");
    expect(fmtPrice(null)).toBe("n/a");
  });
  it("sizes: 5 decimals", () => expect(fmtSize(0.0123456)).toBe("0.01235"));
  it("percentages: signed, 2 decimals", () => {
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-0.005)).toBe("-0.01%");
    expect(fmtPct(0)).toBe("0.00%");
  });
  it("R multiples: signed, 2 decimals", () => {
    expect(fmtR(2.1)).toBe("+2.10R");
    expect(fmtR(-1)).toBe("-1.00R");
    expect(fmtR(null)).toBe("n/a");
  });
  it("usd: signed with separators", () => {
    expect(fmtUsd(1234.5)).toBe("+$1,234.50");
    expect(fmtUsd(-12.3)).toBe("-$12.30");
  });
  it("times and durations", () => {
    expect(fmtTime(T0)).toBe("2026-09-04 12:00Z");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(7_500_000)).toBe("2h 05m");
    expect(fmtDuration(90_061_000)).toBe("1d 1h");
  });
});

describe("formatPnl", () => {
  const out = formatPnl(pnl);
  it("renders a <pre> table with key figures", () => {
    expect(out).toContain("<pre>");
    expect(out).toContain("</pre>");
    expect(out).toContain("Realized");
    expect(out).toContain("+$1,234.56");
    expect(out).toContain("+$245.68 (+2.51%)");
    expect(out).toContain("3 (2W / 1L)");
    expect(out).toContain("+0.75R");
    expect(out).toMatch(/PnL<\/b> — today/);
  });
  it("lists closed trades and caps at 10", () => {
    expect(out).toContain("t-000");
    const many = formatPnl({
      ...pnl,
      rows: Array.from({ length: 14 }, (_, i) => ({ ...pnl.rows[0]!, tradeId: `t-${i}` })),
    });
    expect(many).toContain("… 4 more");
    expect(many).not.toContain("t-13 ");
  });
});

describe("formatPositions", () => {
  it("renders the card with stop/tp from orders", () => {
    const out = formatPositions({ account, market, orders }, T0);
    expect(out).toContain("▲ LONG");
    expect(out).toContain("0.01235 @ 111,234.6");
    expect(out).toContain("3x");
    expect(out).toContain("+$45.68");
    expect(out).toContain("Stop 108,500.0");
    expect(out).toContain("TP 118,000.0");
    expect(out).toContain("Liq 80,000.0");
    expect(out).toContain("mark 112,345.7");
    expect(out).toContain("1 resting entry order(s)");
  });
  it("says so when flat and escapes the symbol", () => {
    const out = formatPositions(
      { account: { ...account, openPositions: [] }, market: { ...market, symbol: "BTC<USD>" }, orders: [] },
      T0,
    );
    expect(out).toContain("No open positions.");
    expect(out).toContain("BTC&lt;USD&gt;");
  });
});

describe("formatOrders", () => {
  it("lists orders with role, trigger and fill state", () => {
    const out = formatOrders(orders);
    expect(out).toContain("Open orders</b> (3)");
    expect(out).toContain("STOP-LOSS sell 0.01235 trig 108,500.0");
    expect(out).toContain("ENTRY buy 0.01000 @ 109,900.0 (0.00200 filled)");
    expect(out).toContain("reduce-only");
    expect(out).toContain("<code>o-stop-1</code>");
  });
  it("handles empty", () => expect(formatOrders([])).toContain("No open orders."));
});

describe("formatCount", () => {
  it("shows the top 3 candidates by score with direction, position, invalidation, entry zone and score", () => {
    const out = formatCount(ew);
    const iTop = out.indexOf("c-top");
    const iMid = out.indexOf("c-mid");
    const iLow = out.indexOf("c-low");
    expect(iTop).toBeGreaterThan(-1);
    expect(iTop).toBeLessThan(iMid);
    expect(iMid).toBeLessThan(iLow);
    expect(out).not.toContain("c-4th");
    expect(out).toContain("1 more candidate(s)");
    expect(out).toContain("1. <b>impulse</b> ▲ LONG · in-wave-2 · score 0.91");
    expect(out).toContain("Invalidation 99,999.9 — below wave 1 start");
    expect(out).toContain("Entry zone 108,000.0–110,000.0");
    expect(out).toContain("Target 118,000.0–121,000.0");
    expect(out).toContain("RSI14 41.20");
    expect(out).toContain("Entry zone n/a");
  });
  it("handles no candidates", () => {
    expect(formatCount({ ...ew, candidates: [] })).toContain("No rule-valid count");
  });
});

describe("formatStatus", () => {
  it("renders running state, uptime, feeds and escaped last error", () => {
    const out = formatStatus(status, T0);
    expect(out).toContain("RUNNING");
    expect(out).toContain("LIVE");
    expect(out).toContain("1d 1h");
    expect(out).toContain("$1.23 / $10.00 today");
    expect(out).toContain("🟢 strike-ws: ok");
    expect(out).toContain("🟡 youtube: degraded");
    expect(out).toContain("quota &lt;low&gt;");
    expect(out).toContain("Timeout &lt;5s&gt; &amp; retry");
    expect(out).toContain("<code>loop-b</code>");
  });
  it("renders halted and paused", () => {
    expect(
      formatStatus({ ...status, halted: true, haltReason: "daily loss", haltedAt: T0 - 1000 }, T0),
    ).toContain("HALTED");
    expect(
      formatStatus({ ...status, halted: true, haltReason: "daily loss", haltedAt: T0 - 1000 }, T0),
    ).toContain("daily loss");
    expect(formatStatus({ ...status, paused: true }, T0)).toContain("PAUSED");
  });
});

describe("formatLimits", () => {
  it("renders every limit in a <pre> table", () => {
    const out = formatLimits(limits);
    expect(out).toContain("<pre>");
    expect(out).toContain("Risk per trade");
    expect(out).toContain("1.00%");
    expect(out).toContain("Max leverage");
    expect(out).toContain("5x");
    expect(out).toContain("2.00:1");
    expect(out).toContain("Max candle age");
    expect(out).toContain("2h 00m");
  });
});

describe("formatWhy", () => {
  it("renders rationale with escaping and timeline", () => {
    const out = formatWhy(why);
    expect(out).toContain("<code>t-001</code>");
    expect(out).toContain("Because &lt;wave 2&gt; ended &amp; RSI diverged.");
    expect(out).toContain("<b>Timeline</b>");
    expect(out).toContain("open");
  });
});

describe("formatDecision", () => {
  it("summarises plan, review, risk and order when allowed", () => {
    const out = formatDecision({ plan, review, risk: riskAllow, order });
    expect(out).toContain("ENTER ▲ LONG · wave-2-end");
    expect(out).toContain("✅ allowed");
    expect(out).toContain("Entry 108,000.0–110,000.0 (limit)");
    expect(out).toContain("Stop 107,000.0");
    expect(out).toContain("prior agrees &lt;mco&gt;");
    expect(out).toContain("Reviewer</b> approve · confidence high");
    expect(out).toContain("R:R 2.70");
    expect(out).toContain("2 checks passed");
    expect(out).toContain("<b>Order</b>");
    expect(out).toContain("Size 0.04500 · notional $4,905.00 · 3x · margin $1,635.00");
  });
  it("lists failed checks when denied", () => {
    const out = formatDecision({
      plan,
      review: { ...review, adjustedConfidence: "medium" },
      risk: riskDeny,
      order: null,
    });
    expect(out).toContain("⛔ blocked");
    expect(out).toContain("✗ confidence: reviewer confidence=medium, required&gt;=high");
    expect(out).not.toContain("<b>Order</b>");
  });
  it("handles non-entry actions", () => {
    const out = formatDecision({
      plan: { ...plan, action: "adjust-stop", newStop: { price: 110_000, label: "trail" } },
      review,
      risk: { ...riskDeny, terminal: "no-op", summary: "not an entry" },
      order: null,
    });
    expect(out).toContain("ADJUST-STOP → 110,000.0");
  });
});

describe("trade events", () => {
  it("order placed", () => {
    const out = formatOrderPlaced({ tradeId: "t-9", order, mode: "shadow", orderId: "ox" });
    expect(out).toContain("Order placed</b> (SHADOW)");
    expect(out).toContain("<code>t-9</code>");
    expect(out).toContain("limit @ 109,000.0");
  });
  it("fill", () => {
    const out = formatFill({
      tradeId: "t-9",
      symbol: "BTC-USD",
      direction: "long",
      role: "stop-loss",
      price: 107_000,
      size: 0.045,
      at: T0,
      feeUsd: 1.5,
    });
    expect(out).toContain("Stop hit");
    expect(out).toContain("0.04500 @ 107,000.0");
    expect(out).toContain("fee $1.50");
  });
  it("stop moved", () => {
    const out = formatStopMoved({
      tradeId: "t-9",
      symbol: "BTC-USD",
      from: 107_000,
      to: 109_000,
      reason: "trail > 1R",
      at: T0,
    });
    expect(out).toContain("107,000.0 → 109,000.0");
    expect(out).toContain("trail &gt; 1R");
  });
  it("exit with realized R", () => {
    const out = formatExit({
      tradeId: "t-9",
      symbol: "BTC-USD",
      direction: "long",
      entryPrice: 109_000,
      exitPrice: 118_000,
      size: 0.045,
      realizedUsd: 405,
      realizedR: 4.5,
      reason: "take-profit",
      openedAt: T0 - 36 * 3_600_000,
      closedAt: T0,
    });
    expect(out).toContain("✅");
    expect(out).toContain("+$405.00 (+4.50R)");
    expect(out).toContain("held 1d 12h");
    expect(
      formatExit({
        tradeId: "t",
        symbol: "s",
        direction: "short",
        entryPrice: 1,
        exitPrice: 2,
        size: 1,
        realizedUsd: -1,
        realizedR: null,
        reason: "stop",
        openedAt: 0,
        closedAt: 1,
      }),
    ).toContain("(n/a)");
  });
});

describe("notices", () => {
  it("prior", () => {
    const out = formatPrior(prior);
    expect(out).toContain("Video ingested");
    expect(out).toContain("Wave 2 &amp; Wave 3 &lt;live&gt;");
    expect(out).toContain("<b>Primary</b> Wave 2 of (3)");
    expect(out).toContain("<b>Alternate</b>");
    expect(out).toContain("Invalidation</b> 100,000.0");
    expect(out).toContain("Entry zone</b> 107,500.0–109,500.0");
  });
  it("halt / resumed / error", () => {
    expect(formatHalt({ reason: "daily loss > 3%", at: T0 })).toContain("daily loss &gt; 3%");
    expect(formatHalt({ reason: "x", at: T0, resumesAt: T0 + 3_600_000 })).toContain(
      "Auto re-arm at 2026-09-04 13:00Z",
    );
    expect(formatResumed({ at: T0, by: "cooldown" })).toContain("after cooldown");
    const err = formatError({ context: "loop-a", message: "boom <x>", at: T0, terminal: "exhausted" });
    expect(err).toContain("<code>loop-a</code>");
    expect(err).toContain("exhausted");
    expect(err).toContain("<pre>boom &lt;x&gt;</pre>");
  });
  it("daily brief scaffold", () => {
    const out = formatDailyBrief(
      [
        { title: "Positions & PnL", body: "<pre>x</pre>" },
        { title: "Empty", body: "   " },
        { title: "Spend", body: "$1.00" },
      ],
      new Date(T0),
    );
    expect(out.startsWith("📋 <b>Daily brief</b> · 2026-09-04")).toBe(true);
    expect(out).toContain("<b>Positions &amp; PnL</b>\n<pre>x</pre>");
    expect(out).not.toContain("Empty");
    expect(out).toContain("<b>Spend</b>\n$1.00");
  });
});

describe("splitMessage", () => {
  const preState = (chunk: string) => {
    let open = false;
    for (const m of chunk.matchAll(/<pre>|<\/pre>/g)) open = m[0] === "<pre>";
    return open;
  };

  it("returns a single chunk when short enough", () => {
    expect(splitMessage("hello", 4096)).toEqual(["hello"]);
  });

  it("splits at newlines and never breaks a line", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} some text`);
    const chunks = splitMessage(lines.join("\n"), 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });

  it("closes and re-opens <pre> across chunks", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `row ${String(i).padStart(3, "0")} | 112,345.6 | +1.00R`,
    );
    const html = `<b>Head</b>\n<pre>${lines.join("\n")}</pre>\ntail`;
    const chunks = splitMessage(html, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect(preState(c)).toBe(false); // every chunk is balanced
    }
    for (let i = 1; i < chunks.length - 1; i++) {
      expect(chunks[i]!.startsWith("<pre>")).toBe(true);
      expect(chunks[i]!.endsWith("</pre>")).toBe(true);
    }
    // Rejoining after removing the inserted tags gives the original text back.
    const rejoined = chunks
      .map((c, i) => {
        let s = c;
        if (i > 0 && s.startsWith("<pre>") && !chunks[i - 1]!.endsWith("</pre>\ntail")) s = s.slice(5);
        if (i < chunks.length - 1 && s.endsWith("</pre>")) s = s.slice(0, -6);
        return s;
      })
      .join("\n");
    expect(rejoined.replace(/<\/pre>\n<pre>/g, "\n")).toBe(html);
  });

  it("hard-splits a single over-long line and keeps <pre> balanced", () => {
    const html = `<pre>${"x".repeat(2500)}</pre>`;
    const chunks = splitMessage(html, 1000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect(c.startsWith("<pre>")).toBe(true);
      expect(c.endsWith("</pre>")).toBe(true);
    }
    expect(chunks.map((c) => c.slice(5, -6)).join("")).toBe("x".repeat(2500));
  });

  it("handles a <pre> that opens mid-message", () => {
    const html = [
      "intro",
      "more intro",
      "<pre>",
      ...Array.from({ length: 50 }, (_, i) => `r${i}`),
      "</pre>",
      "outro",
    ].join("\n");
    const chunks = splitMessage(html, 60);
    for (const c of chunks) expect(preState(c)).toBe(false);
    expect(chunks[0]).toContain("intro");
    expect(chunks.at(-1)).toContain("outro");
  });
});
