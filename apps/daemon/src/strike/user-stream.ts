import type { Logger } from "@surf/core";
import { StrikeUserStream, type WebSocketFactory } from "@surf/strike";
import { formatHalt } from "@surf/telegram";
import type { AppContext } from "../context.js";
import { schema } from "../db/index.js";
import { getOrder, insertEvent, updateOrder } from "../db/queries.js";
import { LiveExecutor, roleOfClientOrderId } from "../execution/executor.js";
import { requestMonitorTick } from "../loops/monitor.js";

export interface UserStreamOptions {
  privateKey: string;
  publicKey?: string | undefined;
  url: string;
  webSocketFactory?: WebSocketFactory | undefined;
}

/**
 * Live only. Fill events update the `orders`/`fills` rows and trigger an immediate monitor tick;
 * liquidation/ADL account updates halt trading.
 */
export function attachUserStream(ctx: AppContext, opts: UserStreamOptions, log: Logger): StrikeUserStream {
  const stream = new StrikeUserStream({
    privateKey: opts.privateKey,
    publicKey: opts.publicKey,
    url: opts.url,
    webSocketFactory: opts.webSocketFactory,
    logger: log,
    now: () => ctx.now(),
  });
  stream.on("subscribed", () => {
    ctx.health.userStreamConnected = true;
    ctx.health.markFeed("strike-ws", "ok", null, ctx.now());
  });
  stream.on("close", (e) => {
    ctx.health.userStreamConnected = false;
    ctx.health.markFeed(
      "strike-ws",
      e.willReconnect ? "degraded" : "down",
      `closed ${e.code} ${e.reason}`,
      ctx.now(),
    );
  });
  stream.on("authError", (e) => {
    ctx.health.markFeed("strike-ws", "down", `auth: ${e.message}`, ctx.now());
    log.error(e, "strike user stream auth error");
  });
  stream.on("giveUp", (e) => ctx.health.markFeed("strike-ws", "down", `gave up: ${e.reason}`, ctx.now()));
  stream.on("orderUpdate", (u) => {
    const now = ctx.now();
    if (ctx.executor instanceof LiveExecutor) ctx.executor.rememberOrderId(u.orderId, u.clientOrderId);
    const ours = roleOfClientOrderId(u.clientOrderId);
    if (ours && getOrder(ctx.db, u.clientOrderId)) {
      updateOrder(
        ctx.db,
        u.clientOrderId,
        {
          exchangeOrderId: String(u.orderId),
          status: u.status.toLowerCase(),
          filledSize: u.cumulativeFilledQty,
          avgFillPrice: u.averagePrice ?? (u.isFill ? u.lastFilledPrice : null),
          raw: u,
        },
        now,
      );
    }
    if (u.isFill) {
      ctx.db
        .insert(schema.fills)
        .values({
          id: `${u.orderId}-${u.tradeId}`,
          clientOrderId: u.clientOrderId || null,
          exchangeOrderId: String(u.orderId),
          symbol: u.symbol,
          side: u.side.toLowerCase(),
          price: u.lastFilledPrice,
          size: u.lastFilledQty,
          fee: u.commission ?? 0,
          role: u.isMaker ? "maker" : "taker",
          realizedPnl: u.realizedProfit ?? 0,
          time: u.transactionTime,
        })
        .onConflictDoNothing()
        .run();
      insertEvent(
        ctx.db,
        "info",
        "ws-fill",
        { clientOrderId: u.clientOrderId, price: u.lastFilledPrice, size: u.lastFilledQty, status: u.status },
        now,
      );
      requestMonitorTick(ctx, `fill ${u.clientOrderId}`);
    }
  });
  stream.on("accountUpdate", (a) => {
    if (/LIQUIDAT|ADL/i.test(a.reason)) {
      const reason = `exchange ${a.reason}`;
      if (!ctx.state.get().halted) ctx.state.halt(reason);
      void ctx.notifier.notify(
        "critical",
        formatHalt({ reason, at: ctx.now(), detail: JSON.stringify(a.positions).slice(0, 400) }),
      );
      requestMonitorTick(ctx, reason);
    }
  });
  stream.connect();
  return stream;
}
