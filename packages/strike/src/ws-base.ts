/**
 * Reconnecting WebSocket foundation shared by the public and user streams.
 *
 * - Frames may contain several newline-delimited JSON events; `parseFrame` splits them.
 * - The server pings every 54s and drops the connection after 60s without a pong. `ws` answers
 *   protocol pings automatically; we additionally run a liveness watchdog that terminates and
 *   reconnects when nothing (message or ping) has arrived for `idleTimeoutMs`.
 * - Reconnects use exponential backoff with jitter and replay subscriptions via `onOpen`.
 * - The WebSocket constructor is injectable so tests can drive a fake.
 */
import WebSocket from "ws";
import type { Logger } from "@surf/core";

/** Minimal surface of `ws` we rely on, so fakes are small. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown, isBinary?: boolean) => void): unknown;
  on(event: "close", cb: (code: number, reason: unknown) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "ping", cb: () => void): unknown;
  on(event: "pong", cb: () => void): unknown;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

export const WS_OPEN = 1;

/** Split a text frame into JSON values: newline-delimited events, top-level arrays flattened. */
export function parseFrame(raw: unknown): unknown[] {
  const text = typeof raw === "string" ? raw : rawToString(raw);
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

function rawToString(raw: unknown): string {
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw.map((b) => Buffer.from(b as Uint8Array))).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}

type Listener<T> = (payload: T) => void;

/** Small typed emitter (avoids `any` from Node's EventEmitter). Listener errors are isolated. */
export class TypedEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      listener(p);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of [...set]) {
      try {
        (l as Listener<Events[K]>)(payload);
      } catch (err) {
        this.onListenerError(event as string, err);
      }
    }
  }

  protected onListenerError(_event: string, _err: unknown): void {
    /* overridden by subclasses to log */
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

export interface BackoffOptions {
  baseMs?: number | undefined;
  maxMs?: number | undefined;
  /** Give up after this many consecutive failures (undefined = forever). */
  maxAttempts?: number | undefined;
  /** 0..1 fraction of random jitter added. */
  jitter?: number | undefined;
}

interface ResolvedBackoff {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  jitter: number;
}

export interface ReconnectingSocketOptions {
  url: string;
  webSocketFactory?: WebSocketFactory | undefined;
  logger?: Logger | undefined;
  backoff?: BackoffOptions | undefined;
  /** Terminate when nothing has been received for this long (default 120s; server pings every 54s). */
  idleTimeoutMs?: number | undefined;
  /** Client-level `{"method":"ping"}` interval; 0 disables (default 0, protocol pings suffice). */
  appPingIntervalMs?: number | undefined;
  random?: (() => number) | undefined;
}

export interface BaseEvents {
  open: void;
  close: { code: number; reason: string; willReconnect: boolean };
  error: Error;
  reconnecting: { attempt: number; delayMs: number };
  /** Every parsed JSON value received, before typed routing. */
  raw: unknown;
  /** Reconnection abandoned (maxAttempts) or a non-recoverable close (subclass decision). */
  giveUp: { code: number; reason: string };
}

export type ConnectionState = "idle" | "connecting" | "open" | "closed";

export abstract class ReconnectingSocket<
  Events extends BaseEvents = BaseEvents,
> extends TypedEmitter<Events> {
  readonly url: string;
  protected readonly logger: Logger | undefined;
  private readonly factory: WebSocketFactory;
  private readonly backoff: ResolvedBackoff;
  private readonly idleTimeoutMs: number;
  private readonly appPingIntervalMs: number;
  private readonly random: () => number;
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private nextId = 1;
  private _state: ConnectionState = "idle";

  constructor(opts: ReconnectingSocketOptions) {
    super();
    this.url = opts.url;
    this.logger = opts.logger;
    this.factory = opts.webSocketFactory ?? defaultWebSocketFactory;
    this.backoff = {
      baseMs: opts.backoff?.baseMs ?? 1000,
      maxMs: opts.backoff?.maxMs ?? 30_000,
      maxAttempts: opts.backoff?.maxAttempts ?? Number.POSITIVE_INFINITY,
      jitter: opts.backoff?.jitter ?? 0.2,
    };
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.appPingIntervalMs = opts.appPingIntervalMs ?? 0;
    this.random = opts.random ?? Math.random;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Consecutive failed connection attempts (reset on a successful open). */
  get reconnectAttempts(): number {
    return this.attempt;
  }

  /** Start connecting; safe to call once. Later calls while running are no-ops. */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Close and stop reconnecting. */
  close(code = 1000, reason = "client close"): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this._state = "closed";
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate?.();
      }
    }
  }

  /** Send a JSON message; returns false when the socket is not open. */
  send(message: unknown): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  protected allocId(): number {
    return this.nextId++;
  }

  /** Called after every (re)connect: replay subscriptions / log on. */
  protected abstract onOpen(): void;
  /** Called for each parsed JSON value. */
  protected abstract onMessage(value: unknown): void;
  /** Return true to stop reconnecting on this close code (e.g. auth rejections). */
  protected isFatalClose(_code: number, _reason: string): boolean {
    return false;
  }

  protected override onListenerError(event: string, err: unknown): void {
    this.logger?.error({ err, event }, "strike ws listener threw");
  }

  private open(): void {
    if (this.stopped) return;
    this._state = "connecting";
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.url);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect(1006, "factory failed");
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this._state = "open";
      this.attempt = 0;
      this.armIdleTimer();
      if (this.appPingIntervalMs > 0) {
        this.pingTimer = setInterval(
          () => this.send({ method: "ping", id: this.allocId() }),
          this.appPingIntervalMs,
        );
      }
      this.emit("open", undefined as Events["open"]);
      this.onOpen();
    });
    ws.on("ping", () => this.armIdleTimer());
    ws.on("pong", () => this.armIdleTimer());
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.armIdleTimer();
      let values: unknown[];
      try {
        values = parseFrame(data);
      } catch (err) {
        this.logger?.warn({ err }, "strike ws: unparseable frame");
        return;
      }
      for (const v of values) {
        this.emit("raw", v as Events["raw"]);
        try {
          this.onMessage(v);
        } catch (err) {
          this.logger?.error({ err }, "strike ws: handler threw");
        }
      }
    });
    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      this.emit("error", err);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      const reasonStr = typeof reason === "string" ? reason : reason ? rawToString(reason) : "";
      const fatal = this.isFatalClose(code, reasonStr);
      const willReconnect = !this.stopped && !fatal;
      this._state = "closed";
      this.emit("close", { code, reason: reasonStr, willReconnect } as Events["close"]);
      if (fatal) {
        this.stopped = true;
        this.emit("giveUp", { code, reason: reasonStr } as Events["giveUp"]);
        return;
      }
      if (willReconnect) this.scheduleReconnect(code, reasonStr);
    });
  }

  private scheduleReconnect(code: number, reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.attempt >= this.backoff.maxAttempts) {
      this.stopped = true;
      this.emit("giveUp", { code, reason: `max reconnect attempts reached (${reason})` } as Events["giveUp"]);
      return;
    }
    const exp = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempt);
    const delayMs = Math.round(exp + exp * this.backoff.jitter * this.random());
    this.attempt++;
    this.emit("reconnecting", { attempt: this.attempt, delayMs } as Events["reconnecting"]);
    this.logger?.info({ attempt: this.attempt, delayMs, code, reason }, "strike ws reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const ws = this.ws;
      if (!ws) return;
      this.logger?.warn({ idleTimeoutMs: this.idleTimeoutMs }, "strike ws idle, terminating");
      // Drop the socket without waiting for the close handshake and let the close handler reconnect.
      if (ws.terminate) ws.terminate();
      else ws.close(4000, "idle timeout");
    }, this.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.pingTimer = null;
  }
}
