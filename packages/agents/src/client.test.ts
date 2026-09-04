import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { wrapAnthropic } from "./client.js";

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe("wrapAnthropic", () => {
  it("passes parse through and narrows the result", async () => {
    const seen: unknown[] = [];
    const stub = {
      messages: {
        parse: async (params: unknown) => {
          seen.push(params);
          return { parsed_output: { a: 1 }, stop_reason: "end_turn", stop_details: null, usage, model: "claude-opus-5", content: [] };
        },
        countTokens: async () => ({ input_tokens: 123 }),
      },
      beta: { messages: { toolRunner: () => ({}) } },
    } as unknown as Anthropic;
    const client = wrapAnthropic(stub);
    const res = await client.parse({ model: "claude-opus-5", max_tokens: 10, messages: [], output_config: { format: zodOutputFormat(z.object({ a: z.number() })) } });
    expect(res.parsed_output).toEqual({ a: 1 });
    expect(res.model).toBe("claude-opus-5");
    expect(seen).toHaveLength(1);
    expect(await client.countTokens({ model: "claude-opus-5", messages: [] })).toBe(123);
  });

  it("iterates the SDK runner, treats resume as a no-op (SDK auto-resumes pause_turn) and forwards done()", async () => {
    const m1 = { content: [], stop_reason: "pause_turn", usage, model: "m" };
    const m2 = { content: [{ type: "text", text: "final" }], stop_reason: "end_turn", usage, model: "m" };
    let pushed = 0;
    let receivedParams: Record<string, unknown> | null = null;
    const runner = {
      async *[Symbol.asyncIterator]() {
        yield m1;
        yield m2;
      },
      pushMessages: () => {
        pushed++;
      },
      done: async () => m2,
    };
    const stub = {
      messages: {},
      beta: {
        messages: {
          toolRunner: (params: Record<string, unknown>) => {
            receivedParams = params;
            return runner;
          },
        },
      },
    } as unknown as Anthropic;
    const wrapped = wrapAnthropic(stub).toolRunner({ model: "m", max_tokens: 1, messages: [], tools: [] });
    const seen: unknown[] = [];
    for await (const m of wrapped) {
      seen.push(m);
      if (m.stop_reason === "pause_turn") wrapped.resumePausedTurn(m);
    }
    expect(seen).toEqual([m1, m2]);
    expect(pushed).toBe(0);
    expect(await wrapped.done()).toBe(m2);
    expect(receivedParams).toMatchObject({ stream: false });
  });
});
