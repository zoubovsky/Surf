/**
 * Token accounting. Every response's `usage` is folded into a running total with a USD cost,
 * so per-stage, per-cycle and per-day budgets are enforceable in code.
 */
export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Breakdown of cache writes by TTL, when the API reports it. */
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
}

export interface UsageTotals {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute-TTL cache write: 1.25x input. */
  cacheWrite5m: number;
  /** 1-hour-TTL cache write: 2x input. */
  cacheWrite1h: number;
}

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/** Keyed by model-id prefix; longest prefix wins (dated ids such as claude-opus-5-20260601 resolve). */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-opus-5": price(5, 25, 0.5),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-haiku-4-5": price(1, 5, 0.1),
  "claude-fable-5-1": price(10, 50, 0.25),
});

/** Unknown models are priced at the most expensive row so budgets fail safe. */
export const FALLBACK_PRICE_MODEL = "claude-fable-5-1";

export function priceFor(model: string): ModelPrice {
  let best: string | null = null;
  for (const key of Object.keys(PRICE_TABLE)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return PRICE_TABLE[best ?? FALLBACK_PRICE_MODEL]!;
}

export const ZERO_USAGE: Readonly<UsageTotals> = Object.freeze({
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Convert one response's usage into totals with cost for the given model. */
export function usageToTotals(model: string, usage: LlmUsage): UsageTotals {
  const p = priceFor(model);
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  let writeCost: number;
  if (usage.cache_creation) {
    const w1h = usage.cache_creation.ephemeral_1h_input_tokens;
    const w5m = usage.cache_creation.ephemeral_5m_input_tokens;
    writeCost = (w1h * p.cacheWrite1h + w5m * p.cacheWrite5m) / 1e6;
  } else {
    writeCost = (write * p.cacheWrite5m) / 1e6;
  }
  const costUsd =
    (usage.input_tokens * p.input + read * p.cacheRead + usage.output_tokens * p.output) / 1e6 + writeCost;
  return {
    inputTokens: usage.input_tokens,
    cachedReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: usage.output_tokens,
    costUsd,
  };
}

/** Accumulates usage across responses. Not shared across cycles: one meter per stage or per cycle. */
export class UsageMeter {
  private total: UsageTotals = { ...ZERO_USAGE };
  private readonly perModel = new Map<string, UsageTotals>();

  add(model: string, usage: LlmUsage): UsageTotals {
    const delta = usageToTotals(model, usage);
    this.total = addTotals(this.total, delta);
    this.perModel.set(model, addTotals(this.perModel.get(model) ?? ZERO_USAGE, delta));
    return delta;
  }

  merge(other: UsageTotals): void {
    this.total = addTotals(this.total, other);
  }

  get totals(): UsageTotals {
    return { ...this.total };
  }

  byModel(): Record<string, UsageTotals> {
    return Object.fromEntries(this.perModel);
  }
}
