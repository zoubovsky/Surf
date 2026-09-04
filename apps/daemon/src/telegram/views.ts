import type { OpenOrderView } from "@surf/telegram";
import type { Db } from "../db/index.js";
import { livePositions } from "../db/queries.js";
import { roleOfClientOrderId, type ExchangeView } from "../execution/executor.js";

function roleOf(id: string, reduceOnly: boolean, type: string): OpenOrderView["role"] {
  const r = roleOfClientOrderId(id)?.role;
  if (r === "entry") return "entry";
  if (r === "stop") return "stop-loss";
  if (r === "take-profit") return "take-profit";
  if (r === "exit") return "exit";
  if (type.startsWith("take_profit")) return "take-profit";
  if (type.startsWith("stop")) return reduceOnly ? "stop-loss" : "other";
  return reduceOnly ? "exit" : "other";
}

function typeOf(type: string): OpenOrderView["type"] {
  if (type === "limit" || type === "market" || type === "stop") return type;
  if (type === "stop_limit") return "stop-limit";
  if (type.startsWith("take_profit")) return "take-profit";
  return "limit";
}

/** Open orders as the operator sees them, tagged with our trade ids where they are ours. */
export function openOrderViews(db: Db, view: ExchangeView): OpenOrderView[] {
  const tracked = new Set(livePositions(db).map((p) => p.id));
  return view.openOrders.map((o) => {
    const ours = roleOfClientOrderId(o.clientOrderId);
    return {
      orderId: o.orderId ?? o.clientOrderId,
      tradeId: ours && tracked.has(ours.positionId) ? ours.positionId : (ours?.positionId ?? null),
      symbol: o.symbol,
      role: roleOf(o.clientOrderId, o.reduceOnly, o.type),
      side: o.side,
      type: typeOf(o.type),
      price: o.price !== null && o.price > 0 ? o.price : null,
      triggerPrice: o.stopPrice !== null && o.stopPrice > 0 ? o.stopPrice : null,
      size: o.size > 0 ? o.size : 0.00001,
      filledSize: Math.max(0, o.filled),
      reduceOnly: o.reduceOnly,
      status: o.status,
      createdAt: o.createdAt,
    };
  });
}
