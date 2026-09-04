import { describe, expect, it } from "vitest";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { AnalystPrior, MarketContext, ReviewVerdict, TradePlan } from "@surf/core";
import { LlmOutputError, LlmRefusalError, LlmTruncatedError } from "./errors.js";
import { briefInput, postTradeInput } from "./prompts.test.js";
import { analyze, analyzeMessages } from "./stages/analyze.js";
import { answerQuestion } from "./stages/answer-question.js";
import { dailyBrief } from "./stages/daily-brief.js";
import { extractPrior } from "./stages/extract-prior.js";
import { postTradeReview } from "./stages/post-trade-review.js";
import { research } from "./stages/research.js";
import { enforceVerdictPolicy, review, untraceableEvidence } from "./stages/review.js";
import { triage } from "./stages/triage.js";
import { createFakeClient, fakeMessage, fakeResponse, stageOf } from "./testing/fake-client.js";
import * as F from "./testing/fixtures.js";
import { createReviewerTools } from "./tools/reviewer-tools.js";

const runnable = (params: { tools: unknown[] }, name: string) =>
  params.tools.find((t) => (t as { name?: string }).name === name) as BetaRunnableTool | undefined;

describe("triage", () => {
  it("uses the triage model with no thinking, no effort and a small max_tokens", async () => {
    const client = createFakeClient({
      onParse: () => ({
        relevant: true,
        isBitcoinAnalysis: true,
        substantive: true,
        reason: "levels and count",
      }),
    });
    const r = await triage({ client, model: "claude-haiku-4-5" }, F.TRANSCRIPT, "Bitcoin wave 2");
    expect(r.output.relevant).toBe(true);
    expect(r.model).toBe("claude-haiku-4-5");
    const p = client.parseCalls[0]!.params;
    expect(p.model).toBe("claude-haiku-4-5");
    expect(p.max_tokens).toBe(512);
    expect(p.thinking).toBeUndefined();
    expect(p.output_config.effort).toBeUndefined();
    expect(stageOf(p)).toBe("triage");
    expect(r.usage.costUsd).toBeGreaterThan(0);
    expect(r.promptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("surfaces refusals and truncation as typed errors", async () => {
    const refusing = createFakeClient({
      onParse: () =>
        fakeResponse({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "general_harms", explanation: "x" },
        }),
    });
    await expect(triage({ client: refusing, model: "claude-haiku-4-5" }, "t", "t")).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
    const truncating = createFakeClient({ onParse: () => fakeResponse({ stop_reason: "max_tokens" }) });
    await expect(triage({ client: truncating, model: "claude-haiku-4-5" }, "t", "t")).rejects.toBeInstanceOf(
      LlmTruncatedError,
    );
  });
});

describe("extractPrior", () => {
  it("runs Opus with adaptive thinking at high effort, overrides identity fields and verifies evidence", async () => {
    const modelOutput = {
      ...F.prior(),
      videoId: "WRONG",
      asset: "BTC",
      targets: [...F.prior().targets, { price: 99_000, label: "invented" }],
    };
    const client = createFakeClient({ onParse: () => modelOutput });
    const r = await extractPrior(
      { client, model: "claude-opus-5" },
      {
        videoId: "vid1",
        title: "T",
        publishedAt: F.NOW - 6 * F.H,
        transcriptText: F.TRANSCRIPT,
        keywordWindows: [],
      },
    );
    const p = client.parseCalls[0]!.params;
    expect(p.model).toBe("claude-opus-5");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config.effort).toBe("high");
    expect(p.max_tokens).toBe(16_000);
    expect(JSON.stringify(p.output_config.format.schema)).not.toContain("maxLength");
    expect(r.output.videoId).toBe("vid1");
    expect(r.output.targets).toEqual([{ price: 82_400, label: "wave 3 first target" }]);
    expect(r.output.confidence).toBe("medium");
    expect(r.verification.levelsDropped).toHaveLength(1);
    expect(AnalystPrior.parse(r.output)).toEqual(r.output);
  });

  it("rejects an output that violates the schema even after clipping", async () => {
    const client = createFakeClient({ onParse: () => ({ ...F.prior(), bias: "sideways" }) });
    await expect(
      extractPrior(
        { client, model: "claude-opus-5" },
        { videoId: "vid1", title: "T", publishedAt: F.NOW, transcriptText: F.TRANSCRIPT, keywordWindows: [] },
      ),
    ).rejects.toThrow();
  });
});

describe("research", () => {
  const input = {
    market: F.market(),
    funding: [{ time: F.NOW - F.H, rateHourly: 0.00001 }],
    openInterestHistory: [{ time: F.NOW - F.H, openInterestUsd: 1_000_000 }],
    recentHeadlines: [{ source: "coindesk.com", publishedAt: F.NOW - F.H, title: "ETF inflows" }],
  };

  it("configures the runner with the allow-listed web search and the numbers tool, resumes pause_turn, then coerces", async () => {
    const paused = fakeMessage("searching...", { stop_reason: "pause_turn" });
    const client = createFakeClient({
      onToolRunner: () => [
        paused,
        fakeMessage("Regime: trending-up\nFunding: neutral\nBrief: BTC up.", { stop_reason: "end_turn" }),
      ],
      onParse: () => ({ ...F.context(), brief: "b".repeat(1_600), asOf: 1, fundingRateHourly: 42 }),
    });
    const r = await research({ client, model: "claude-sonnet-5" }, input);
    const rp = client.runnerCalls[0]!.params;
    expect(rp.model).toBe("claude-sonnet-5");
    expect(rp.thinking).toEqual({ type: "adaptive" });
    expect(rp.output_config?.effort).toBe("medium");
    expect(rp.max_iterations).toBe(8);
    const web = rp.tools.find((t) => (t as { type?: string }).type === "web_search_20260209") as {
      max_uses: number;
      allowed_domains: string[];
      name: string;
    };
    expect(web.name).toBe("web_search");
    expect(web.max_uses).toBe(4);
    expect(web.allowed_domains).toEqual([
      "coindesk.com",
      "theblock.co",
      "cointelegraph.com",
      "reuters.com",
      "bloomberg.com",
      "cmegroup.com",
      "federalreserve.gov",
      "forexfactory.com",
    ]);
    const numbers = runnable(rp, "get_market_numbers")!;
    expect(
      JSON.parse(
        (await numbers.run(
          {},
          {
            toolUse: { type: "tool_use", id: "x", name: "get_market_numbers", input: {} },
            toolUseBlock: { type: "tool_use", id: "x", name: "get_market_numbers", input: {} },
          },
        )) as string,
      ),
    ).toMatchObject({ markPrice: 78_400 });
    // pause_turn handling
    expect(client.resumed).toEqual([paused]);
    expect(r.pausedTurns).toBe(1);
    expect(r.iterations).toBe(2);
    // coercion call
    const cp = client.parseCalls[0]!.params;
    expect(stageOf(cp)).toBe("research-coerce");
    expect(cp.model).toBe("claude-sonnet-5");
    expect(JSON.stringify(cp.messages)).toContain("Regime: trending-up");
    // output is the exact core type, with code-owned fields forced
    expect(r.output.brief.length).toBe(1_500);
    expect(r.output.asOf).toBe(F.NOW);
    expect(r.output.fundingRateHourly).toBe(0.00001);
    expect(MarketContext.parse(r.output)).toEqual(r.output);
    expect(r.notes).toContain("Brief: BTC up.");
    // usage sums both runner iterations and the coercion call
    expect(r.usage.inputTokens).toBe(3_000);
  });

  it("fails loudly when the runner ends without text", async () => {
    const client = createFakeClient({
      onToolRunner: () => [
        {
          content: [],
          stop_reason: "pause_turn",
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "m",
        },
      ],
      onParse: () => F.context(),
    });
    await expect(research({ client, model: "claude-sonnet-5" }, input)).rejects.toBeInstanceOf(
      LlmOutputError,
    );
  });

  it("aborts on a refusal mid-run", async () => {
    const client = createFakeClient({
      onToolRunner: () => [fakeMessage("", { stop_reason: "refusal" })],
      onParse: () => F.context(),
    });
    await expect(research({ client, model: "claude-sonnet-5" }, input)).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
  });
});

describe("analyze", () => {
  const input = {
    ew: { h1: F.ewAnalysis(), h4: F.ew4h() },
    prior: F.prior(),
    context: F.context(),
    account: F.account(),
    market: F.market(),
    state: F.state(),
    limits: F.limits(),
    calibration: null,
    lessons: [],
  };

  it("runs Opus adaptive/high and returns the exact TradePlan", async () => {
    const client = createFakeClient({ onParse: () => ({ ...F.plan(), rationale: "r".repeat(2_500) }) });
    const r = await analyze({ client, model: "claude-opus-5" }, input);
    const p = client.parseCalls[0]!.params;
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config.effort).toBe("high");
    expect(p.messages).toHaveLength(1);
    expect(r.output.rationale.length).toBe(2_000);
    expect(TradePlan.parse(r.output)).toEqual(r.output);
    expect(JSON.stringify(p.messages)).not.toContain("riskPerTradePct");
    expect(JSON.stringify(p.messages)).not.toContain("maxLeverage");
  });

  it("routes reviewer feedback through a system message on Opus 5 and a user block elsewhere", () => {
    const revision = {
      round: 1,
      review: F.verdict({ verdict: "revise", reasons: ["widen the stop buffer"] }),
    };
    const opus = analyzeMessages("claude-opus-5", input, revision);
    expect(opus).toHaveLength(2);
    expect(opus[1]!.role).toBe("system");
    expect(opus[1]!.content).toContain("widen the stop buffer");
    const sonnet = analyzeMessages("claude-sonnet-5", input, revision);
    expect(sonnet[1]!.role).toBe("user");
    expect(sonnet[1]!.content).toContain("<reviewer_revision_request>");
  });

  it("rejects an enter plan with missing legs", async () => {
    const client = createFakeClient({ onParse: () => F.plan({ stopLoss: null }) });
    await expect(analyze({ client, model: "claude-opus-5" }, input)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe("review", () => {
  const input = {
    plan: F.plan(),
    ew: { h1: F.ewAnalysis(), h4: F.ew4h() },
    prior: F.prior(),
    context: F.context(),
    account: F.account(),
    market: F.market(),
    state: F.state(),
    limits: F.limits(),
  };
  const tools = () =>
    createReviewerTools({ ew: input.ew, prior: input.prior, market: input.market, limits: input.limits });

  it("exposes the four deterministic tools, uses the adversarial prompt and coerces the verdict", async () => {
    const client = createFakeClient({
      onToolRunner: () => [fakeMessage("1. dataFresh PASS ... verdict approve, confidence medium")],
      onParse: () =>
        F.verdict({
          adjustedConfidence: "medium",
          checks: { ...F.verdict().checks, rewardRiskRecomputed: null },
        }),
    });
    const r = await review({ client, model: "claude-opus-5" }, input, tools());
    const rp = client.runnerCalls[0]!.params;
    expect(stageOf(rp)).toBe("review");
    expect(rp.tools.map((t) => (t as { name: string }).name).sort()).toEqual([
      "check_stop_vs_invalidation",
      "get_candidate",
      "get_prior_levels",
      "recompute_reward_risk",
    ]);
    expect(rp.thinking).toEqual({ type: "adaptive" });
    expect(rp.output_config?.effort).toBe("high");
    const msg = JSON.stringify(rp.messages);
    expect(msg).toContain("<trade_plan>");
    expect(msg).toContain("<deterministic_prechecks>");
    expect(msg).not.toContain("riskPerTradePct");
    const ctx = {
      toolUse: { type: "tool_use" as const, id: "1", name: "x", input: {} },
      toolUseBlock: { type: "tool_use" as const, id: "1", name: "x", input: {} },
    };
    expect(
      JSON.parse((await runnable(rp, "get_candidate")!.run({ id: "1h:imp-3" }, ctx)) as string),
    ).toMatchObject({ id: "1h:imp-3" });
    expect(
      JSON.parse((await runnable(rp, "recompute_reward_risk")!.run({}, ctx)) as string).rewardRisk,
    ).toBeCloseTo(1.697, 2);
    expect(JSON.parse((await runnable(rp, "check_stop_vs_invalidation")!.run({}, ctx)) as string).ok).toBe(
      true,
    );
    expect(JSON.parse((await runnable(rp, "get_prior_levels")!.run({}, ctx)) as string).videoId).toBe("vid1");
    expect(stageOf(client.parseCalls[0]!.params)).toBe("review-coerce");
    expect(r.output.adjustedConfidence).toBe("medium");
    expect(r.output.checks.rewardRiskRecomputed).toBeCloseTo(1.697, 2);
    expect(r.enforced).toContain("rewardRiskRecomputed filled from tool");
    expect(ReviewVerdict.parse(r.output)).toEqual(r.output);
  });

  it("clamps adjustedConfidence to the plan's confidence", async () => {
    const client = createFakeClient({
      onToolRunner: () => [fakeMessage("findings")],
      onParse: () => F.verdict({ adjustedConfidence: "high" }),
    });
    const r = await review(
      { client, model: "claude-opus-5" },
      { ...input, plan: F.plan({ confidence: "medium" }) },
      tools(),
    );
    expect(r.output.adjustedConfidence).toBe("medium");
    expect(r.enforced).toContain("adjustedConfidence clamped high -> medium");
  });

  it("downgrades an approve to revise when evidence is untraceable", async () => {
    const plan = F.plan({ evidence: ["1h:imp-3", "my gut feeling"] });
    expect(untraceableEvidence(plan, input.ew, input.prior, input.context)).toEqual(["my gut feeling"]);
    const client = createFakeClient({
      onToolRunner: () => [fakeMessage("findings")],
      onParse: () => F.verdict(),
    });
    const r = await review({ client, model: "claude-opus-5" }, { ...input, plan }, tools());
    expect(r.output.verdict).toBe("revise");
    expect(r.output.checks.evidenceTraceable).toBe(false);
    expect(r.output.severity).toBe("minor");
    expect(r.output.reasons.at(-1)).toContain("my gut feeling");
    const userText = client.runnerCalls[0]!.params.messages[0]!.content as string;
    expect(userText).toContain('"unknownEvidence": [\n  "my gut feeling"\n ]');
  });

  it("forces reject when the candidate does not exist", () => {
    const pre = {
      unknownEvidence: [],
      candidateExists: false,
      marketAgeSec: 0,
      accountAgeSec: 0,
      candleAgeMin: 1,
      priorFreshness: null,
    };
    const { verdict, enforced } = enforceVerdictPolicy(F.verdict(), F.plan({ candidateId: "ghost" }), pre, 2);
    expect(verdict.verdict).toBe("reject");
    expect(verdict.severity).toBe("major");
    expect(enforced).toContain("forced reject: candidate id not found");
  });

  it("recognises headline/event indices and indicator names as traceable", () => {
    const plan = F.plan({
      evidence: ["headline:0", "event 0", "RSI14 = 42", "funding neutral", "headline:7"],
    });
    expect(untraceableEvidence(plan, input.ew, input.prior, input.context)).toEqual(["headline:7"]);
  });
});

describe("post-trade review, daily brief, answer", () => {
  it("postTradeReview runs Opus at medium effort and anchors the lesson to the trade", async () => {
    const client = createFakeClient({
      onParse: () => ({
        decisionQuality: "acceptable",
        outcome: "loss",
        failureMode: "stop-too-tight",
        lesson: { text: "widen buffers", evidenceTradeIds: ["t0"] },
        summary: "s",
      }),
    });
    const r = await postTradeReview({ client, model: "claude-opus-5" }, postTradeInput());
    expect(client.parseCalls[0]!.params.output_config.effort).toBe("medium");
    expect(r.output.lesson?.evidenceTradeIds).toEqual(["t1", "t0"]);
  });

  it("dailyBrief returns clipped prose from Sonnet at low effort", async () => {
    const client = createFakeClient({ onParse: () => ({ brief: "Positions: none. ".repeat(200) }) });
    const r = await dailyBrief({ client, model: "claude-sonnet-5" }, briefInput());
    expect(r.output.length).toBeLessThanOrEqual(1_200);
    expect(client.parseCalls[0]!.params.output_config.effort).toBe("low");
    expect(client.parseCalls[0]!.params.model).toBe("claude-sonnet-5");
  });

  it("answerQuestion has no tools and wraps the question", async () => {
    const client = createFakeClient({ onParse: () => ({ answer: "You are flat; PnL today 0." }) });
    const r = await answerQuestion(
      { client, model: "claude-sonnet-5" },
      {
        question: "positions?",
        context: {
          asOf: F.NOW,
          positions: [],
          pnl: { todayUsd: 0 },
          recentDecisions: [],
          limits: F.limits(),
        },
      },
    );
    expect(r.output).toBe("You are flat; PnL today 0.");
    const p = client.parseCalls[0]!.params;
    expect(p.tools).toBeUndefined();
    expect(JSON.stringify(p.messages)).toContain("<untrusted_operator_question>");
  });
});
