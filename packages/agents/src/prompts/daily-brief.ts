import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { DailyBriefInput } from "../types.js";
import { dataBlock, isoTime, userMessage } from "./shared.js";

export const DAILY_BRIEF_MAX_CHARS = 1200;

export const SYSTEM_DAILY_BRIEF = `You write the operator's daily brief for an autonomous Bitcoin trading system. You receive structured facts computed by code. Produce plain prose of at most 1200 characters (no markdown, no HTML, no bullet symbols; short sentences, line breaks between topics are fine). Cover, in order: open positions and resting orders; PnL today / 7d / 30d and equity; the latest analyst video thesis versus our own count; funding, open interest and regime; macro events in the next 48h; calibration in one sentence if available; LLM spend versus budget; any halt, pause or error. Use the numbers as given, rounded sensibly; do not compute new statistics; do not advise or predict. If a section has no data, say so in three words or fewer.`;

export function buildDailyBriefUserMessage(input: DailyBriefInput): MessageParam {
  return userMessage(
    `Brief time: ${isoTime(input.asOf)} (${input.timezone}).`,
    dataBlock("brief_data", input),
    "Write the brief.",
  );
}
