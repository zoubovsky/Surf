/**
 * Error types raised by the Strike client.
 *
 * `StrikeApiError` carries the HTTP status and the venue's error body so callers can branch on
 * `status`/`code` (for example 401 = credentials rejected, 400 INVALID_PARAMETER = bad order).
 */

interface ErrorBodyShape {
  error?: unknown;
  code?: unknown;
  msg?: unknown;
  message?: unknown;
}

export class StrikeApiError extends Error {
  override readonly name = "StrikeApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  readonly requestId: string | undefined;
  readonly method: string;
  readonly path: string;

  constructor(args: {
    status: number;
    code?: string | undefined;
    message: string;
    body: unknown;
    requestId?: string | undefined;
    method: string;
    path: string;
  }) {
    super(
      `${args.method} ${args.path} -> ${args.status}${args.code ? ` ${args.code}` : ""}: ${args.message}`,
    );
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
    this.requestId = args.requestId;
    this.method = args.method;
    this.path = args.path;
  }

  /** 5xx, 408 and 429 are worth retrying for idempotent requests; other 4xx are not. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Build from a raw response body (JSON text or already-parsed). Tolerates every documented error shape. */
  static fromResponse(args: {
    status: number;
    bodyText: string;
    requestId?: string | undefined;
    method: string;
    path: string;
  }): StrikeApiError {
    let body: unknown = args.bodyText;
    try {
      body = args.bodyText.length > 0 ? JSON.parse(args.bodyText) : undefined;
    } catch {
      /* keep the raw text */
    }
    const shape = (typeof body === "object" && body !== null ? body : {}) as ErrorBodyShape;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
    const code = str(shape.code);
    const message =
      str(shape.msg) ??
      str(shape.message) ??
      str(shape.error) ??
      (typeof body === "string" && body.length > 0 ? body : `HTTP ${args.status}`);
    return new StrikeApiError({
      status: args.status,
      code: code ?? (str(shape.error) && str(shape.error) !== message ? str(shape.error) : undefined),
      message,
      body,
      requestId: args.requestId,
      method: args.method,
      path: args.path,
    });
  }
}

/** The venue returned 2xx but the payload did not match the schema we expect. */
export class StrikeParseError extends Error {
  override readonly name = "StrikeParseError";
  readonly endpoint: string;
  readonly issues: unknown;
  readonly data: unknown;
  constructor(endpoint: string, issues: unknown, data: unknown) {
    super(`Unexpected response shape from ${endpoint}: ${JSON.stringify(issues).slice(0, 500)}`);
    this.endpoint = endpoint;
    this.issues = issues;
    this.data = data;
  }
}

/** Client misuse: missing credentials, unknown symbol rules, etc. */
export class StrikeConfigError extends Error {
  override readonly name = "StrikeConfigError";
}

/** A request did not complete (network failure or timeout). Distinct from a venue error response. */
export class StrikeNetworkError extends Error {
  override readonly name = "StrikeNetworkError";
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}
