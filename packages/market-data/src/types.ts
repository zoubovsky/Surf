/** Minimal fetch signature so the daemon (or tests) can inject their own. */
export type FetchLike = typeof fetch;

/**
 * Structural logger accepted by this package. `pino.Logger` (core `createLogger`) satisfies it;
 * tests can pass a plain object.
 */
export interface MarketLogger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export const noopLogger: MarketLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
