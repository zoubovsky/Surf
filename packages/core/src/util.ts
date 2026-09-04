export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** Floor a timestamp to the start of its interval bucket. */
export function floorToInterval(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

/** Retry an async function with exponential backoff. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; onError?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      opts.onError?.(err, i);
      if (i < attempts - 1) await sleep(Math.min(max, base * 2 ** i) + Math.random() * 100);
    }
  }
  throw lastErr;
}

export function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}
