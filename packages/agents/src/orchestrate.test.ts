import { describe, expect, it } from "vitest";
import { MAX_REVISIONS, runDecisionStages, type DecisionInputs } from "./orchestrate.js";
import {
  createFakeClient,
  fakeMessage,
  fakeResponse,
  stageOf,
  type FakeLlmClient,
} from "./testing/fake-client.js";
import * as F from "./testing/fixtures.js";

function inputs(over: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    ew: { h1: F.ewAnalysis(), h4: F.ew4h() },
    prior: F.prior(),
    account: F.account(),
    market: F.market(),
    state: F.state(),
    limits: F.limits(),
    calibration: null,
    lessons: [],
    research: { funding: [], openInterestHistory: [] },
    ...over,
  };
}

const models = { researcher: "claude-sonnet-5", analyst: "claude-opus-5", reviewer: "claude-opus-5" };

/** Fake that answers every stage; verdicts are taken from the queue in order. */
function scripted(
  verdicts: Array<"approve" | "revise" | "reject">,
  planFor: (round: number) => unknown = () => F.plan(),
): FakeLlmClient {
  let analyzeRound = 0;
  let reviewRound = 0;
  return createFakeClient({
    onToolRunner: () => [fakeMessage("notes")],
    onParse: (params) => {
      switch (stageOf(params)) {
        case "research-coerce":
          return F.context();
        case "analyze":
          return planFor(analyzeRound++);
        case "review-coerce": {
          const v = verdicts[reviewRound++] ?? "revise";
          return F.verdict({
            verdict: v,
            severity: v === "approve" ? "none" : v === "revise" ? "minor" : "major",
            reasons: [`${v} reason`],
          });
        }
        default:
          throw new Error(`unexpected stage ${stageOf(params)}`);
      }
    },
  });
}

const stageNames = (client: FakeLlmClient) => client.parseCalls.map((c) => stageOf(c.params));

describe("runDecisionStages", () => {
  it("approves on the first round and journals every stage", async () => {
    const client = scripted(["approve"]);
    const run = await runDecisionStages({ client, models, budgetUsd: 5 }, inputs());
    expect(run.terminal).toBe("approved");
    expect(run.revisions).toBe(0);
    expect(run.plan).toEqual(F.plan());
    expect(run.review?.verdict).toBe("approve");
    expect(run.stages.map((s) => `${s.stage}:${s.round}`)).toEqual(["research:0", "analyze:0", "review:0"]);
    for (const s of run.stages) {
      expect(s.promptHash).toMatch(/^[0-9a-f]{16}$/);
      expect(s.usage.costUsd).toBeGreaterThan(0);
      expect(s.output).toBeDefined();
    }
    expect(run.stages[0]!.model).toBe("claude-sonnet-5");
    expect(run.stages[1]!.model).toBe("claude-opus-5");
    expect(run.totalUsage.costUsd).toBeCloseTo(
      run.stages.reduce((a, s) => a + s.usage.costUsd, 0),
      12,
    );
    expect(stageNames(client)).toEqual(["research-coerce", "analyze", "review-coerce"]);
  });

  it("stops on reject", async () => {
    const run = await runDecisionStages({ client: scripted(["reject"]), models, budgetUsd: 5 }, inputs());
    expect(run.terminal).toBe("rejected");
    expect(run.reason).toContain("reject reason");
    expect(run.stages).toHaveLength(3);
  });

  it("bounds the revise loop at MAX_REVISIONS and ends exhausted, feeding reasons back", async () => {
    const client = scripted(["revise", "revise", "revise", "revise"]);
    const run = await runDecisionStages({ client, models, budgetUsd: 50 }, inputs());
    expect(MAX_REVISIONS).toBe(2);
    expect(run.terminal).toBe("exhausted");
    expect(run.revisions).toBe(2);
    expect(run.stages.filter((s) => s.stage === "analyze")).toHaveLength(3);
    expect(run.stages.filter((s) => s.stage === "review")).toHaveLength(3);
    const analyzeCalls = client.parseCalls.filter((c) => stageOf(c.params) === "analyze");
    expect(analyzeCalls[0]!.params.messages).toHaveLength(1);
    expect(analyzeCalls[1]!.params.messages).toHaveLength(2);
    expect(analyzeCalls[1]!.params.messages[1]).toMatchObject({ role: "system" });
    expect(JSON.stringify(analyzeCalls[2]!.params.messages[1])).toContain("Revision request 2");
  });

  it("approves after one revision", async () => {
    const run = await runDecisionStages(
      { client: scripted(["revise", "approve"]), models, budgetUsd: 50 },
      inputs(),
    );
    expect(run.terminal).toBe("approved");
    expect(run.revisions).toBe(1);
    expect(run.stages).toHaveLength(5);
  });

  it("ends exhausted when the USD budget is exceeded, without running later stages", async () => {
    const client = createFakeClient({
      onToolRunner: () => [fakeMessage("notes", { usage: { input_tokens: 400_000, output_tokens: 10_000 } })],
      onParse: (params) => {
        if (stageOf(params) === "research-coerce")
          return fakeResponse({
            output: F.context(),
            usage: { input_tokens: 200_000, output_tokens: 5_000 },
          });
        throw new Error("should not reach " + stageOf(params));
      },
    });
    const run = await runDecisionStages({ client, models, budgetUsd: 0.5 }, inputs());
    expect(run.terminal).toBe("exhausted");
    expect(run.plan).toBeNull();
    expect(run.reason).toMatch(/budget exceeded after research/);
    expect(run.totalUsage.costUsd).toBeGreaterThan(0.5);
    expect(run.stages).toHaveLength(1);
  });

  it("ends exhausted mid-loop when a later stage tips the budget", async () => {
    const client = scripted(["revise", "approve"]);
    const run = await runDecisionStages({ client, models, budgetUsd: 0.03 }, inputs());
    expect(run.terminal).toBe("exhausted");
    expect(run.reason).toMatch(/budget exceeded/);
    expect(run.plan).not.toBeNull();
  });

  it("skips the reviewer for no-trade plans and reuses a supplied context", async () => {
    const client = scripted([], () =>
      F.plan({ action: "no-trade", entry: null, entryKind: null, stopLoss: null, takeProfit: null }),
    );
    const run = await runDecisionStages({ client, models, budgetUsd: 5, context: F.context() }, inputs());
    expect(run.terminal).toBe("approved");
    expect(run.review).toBeNull();
    expect(run.stages.map((s) => s.stage)).toEqual(["analyze"]);
    expect(client.runnerCalls).toHaveLength(0);
  });

  it("uses caller-supplied reviewer tools", async () => {
    let called = 0;
    const client = scripted(["approve"]);
    await runDecisionStages(
      {
        client,
        models,
        budgetUsd: 5,
        reviewerTools: () => ({
          getCandidate: () => null,
          checkStopVsInvalidation: () => ({
            ok: true,
            detail: "",
            stop: null,
            invalidation: null,
            bufferPct: null,
            stopDistancePct: null,
          }),
          recomputeRewardRisk: () => {
            called++;
            return {
              rewardRisk: 3,
              detail: "",
              entryPrice: null,
              riskPerUnit: null,
              rewardPerUnitAfterCosts: null,
              feePerUnit: null,
              fundingPerUnit: null,
            };
          },
          getPriorLevels: () => null,
        }),
      },
      inputs(),
    );
    expect(called).toBeGreaterThan(0);
  });
});
