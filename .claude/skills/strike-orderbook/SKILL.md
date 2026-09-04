---
name: strike-orderbook
description: Strike Finance orderbook integration — REST snapshots, WebSocket delta patching, VWAP estimation. Use when building orderbook displays or calculating fill prices.
---

# Strike Finance Orderbook

Real-time orderbook data with REST snapshots and WebSocket delta streaming. Supports synchronized state management and VWAP fill price estimation.

## REST Endpoint

**GET** `https://api.strikefinance.org/price/v2/depth?symbol=BTC-USD&limit=100`

Response shape:

```typescript
interface DepthSnapshot {
  lastUpdateId: number; // uint64 — can exceed Number.MAX_SAFE_INTEGER, use BigInt
  E: number;           // event time (ms)
  T: number;           // transaction time (ms)
  bids: string[][];    // [[price, quantity], ...] — highest price first
  asks: string[][];    // [[price, quantity], ...] — lowest price first
}
```

- Each entry is `[price, quantity]` as strings.
- Cached 5 seconds server-side.

## WebSocket

**URL:** `wss://api.strikefinance.org/ws/price` (public, no auth)

### Subscribe

```json
{"id": 1713960000000, "method": "subscribe", "channel": "depth", "symbol": "btc-usd"}
```

**Symbol must be lowercase** in subscribe/unsubscribe messages.

### Unsubscribe

```json
{"id": 1713960000000, "method": "unsubscribe", "channel": "depth", "symbol": "btc-usd"}
```

### Event Format

```typescript
interface DepthUpdateEvent {
  e: "depthUpdate";
  s: string;              // symbol, e.g. "BTC-USD"
  u: number;              // updateId
  b: [string, string][];  // bid deltas: [[price, qty], ...]
  a: [string, string][];  // ask deltas: [[price, qty], ...]
}
```

- `qty = "0"` means **remove** that price level entirely.

## Synchronization Pattern (Critical)

Follow this exact sequence to build a consistent local orderbook:

1. **Subscribe** to the WS depth channel.
2. **Fetch** the REST `/v2/depth` snapshot and record `lastUpdateId`.
3. **Buffer** any WS events that arrive before the snapshot (queue up to 200).
4. **Replay** buffered events where `u > lastUpdateId`.
5. For each subsequent WS event: if `u <= lastAppliedId`, **skip** (stale). Otherwise apply the delta.
6. **Apply delta:** for each `[price, qty]` — if `qty = "0"`, delete from Map; otherwise set `Map[price] = qty`.
7. **Convert** Map to sorted array: bids descending by price, asks ascending by price.

### Important Notes

- `lastUpdateId` can exceed `Number.MAX_SAFE_INTEGER` — use `BigInt` for comparisons.
- `+1` continuity between `u` values is **NOT** guaranteed (the engine skips IDs when there is no change).
- Do **NOT** treat ID gaps as missed updates.
- Use `requestAnimationFrame` batching for UI updates (do not re-render on every WS message).
- Throttle component re-renders to ~150ms for performance.

## VWAP Fill Estimation

Calculate the volume-weighted average price a market order would receive:

```typescript
function estimateMarketFillPrice(
  orderBook: { bids: [string, string][]; asks: [string, string][] },
  side: "Long" | "Short",
  size: number
): number | null {
  const levels = side === "Long" ? orderBook.asks : orderBook.bids;
  let cost = 0;
  let filled = 0;

  for (const [priceStr, qtyStr] of levels) {
    const price = parseFloat(priceStr);
    const qty = parseFloat(qtyStr);
    const fill = Math.min(size - filled, qty);
    cost += fill * price;
    filled += fill;
    if (filled >= size) break;
  }

  return filled >= size ? cost / filled : null;
}
```

Returns `null` if the orderbook does not have enough liquidity to fill the order.

## Full Implementation Example

```typescript
type PriceLevel = [string, string]; // [price, quantity]

class OrderBookManager {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private lastAppliedId = BigInt(0);
  private snapshotReceived = false;
  private buffer: DepthUpdateEvent[] = [];
  private ws: WebSocket | null = null;
  private updateCallback: (() => void) | null = null;
  private rafId: number | null = null;
  private lastRenderTime = 0;
  private readonly THROTTLE_MS = 150;

  constructor(private symbol: string) {}

  async start(onUpdate: () => void): Promise<void> {
    this.updateCallback = onUpdate;

    // Step 1: Connect WebSocket
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        id: Date.now(),
        method: "subscribe",
        channel: "depth",
        symbol: this.symbol.toLowerCase(),
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.e !== "depthUpdate") return;
      this.handleWsEvent(data);
    };

    // Step 2: Fetch REST snapshot
    const res = await fetch(
      `https://api.strikefinance.org/price/v2/depth?symbol=${this.symbol}&limit=100`
    );
    const snapshot: DepthSnapshot = await res.json();

    // Apply snapshot
    this.bids.clear();
    this.asks.clear();
    for (const [price, qty] of snapshot.bids) this.bids.set(price, qty);
    for (const [price, qty] of snapshot.asks) this.asks.set(price, qty);
    this.lastAppliedId = BigInt(snapshot.lastUpdateId);

    // Step 4: Replay buffered events
    for (const buffered of this.buffer) {
      if (BigInt(buffered.u) > this.lastAppliedId) {
        this.applyDelta(buffered);
      }
    }
    this.buffer = [];
    this.snapshotReceived = true;

    this.scheduleUpdate();
  }

  private handleWsEvent(event: DepthUpdateEvent): void {
    if (!this.snapshotReceived) {
      // Step 3: Buffer pre-snapshot events
      if (this.buffer.length < 200) {
        this.buffer.push(event);
      }
      return;
    }

    // Step 5: Skip stale events
    if (BigInt(event.u) <= this.lastAppliedId) return;

    this.applyDelta(event);
    this.scheduleUpdate();
  }

  // Step 6: Apply delta
  private applyDelta(event: DepthUpdateEvent): void {
    for (const [price, qty] of event.b) {
      if (qty === "0") this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const [price, qty] of event.a) {
      if (qty === "0") this.asks.delete(price);
      else this.asks.set(price, qty);
    }
    this.lastAppliedId = BigInt(event.u);
  }

  private scheduleUpdate(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const now = Date.now();
      if (now - this.lastRenderTime >= this.THROTTLE_MS) {
        this.lastRenderTime = now;
        this.updateCallback?.();
      } else {
        // Schedule deferred update
        setTimeout(() => this.scheduleUpdate(), this.THROTTLE_MS - (now - this.lastRenderTime));
      }
    });
  }

  // Step 7: Get sorted arrays
  getSortedBids(): PriceLevel[] {
    return [...this.bids.entries()]
      .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
  }

  getSortedAsks(): PriceLevel[] {
    return [...this.asks.entries()]
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  }

  getSnapshot(): { bids: PriceLevel[]; asks: PriceLevel[] } {
    return {
      bids: this.getSortedBids(),
      asks: this.getSortedAsks(),
    };
  }

  estimateFillPrice(side: "Long" | "Short", size: number): number | null {
    const levels = side === "Long" ? this.getSortedAsks() : this.getSortedBids();
    let cost = 0;
    let filled = 0;

    for (const [priceStr, qtyStr] of levels) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const fill = Math.min(size - filled, qty);
      cost += fill * price;
      filled += fill;
      if (filled >= size) break;
    }

    return filled >= size ? cost / filled : null;
  }

  destroy(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({
        id: Date.now(),
        method: "unsubscribe",
        channel: "depth",
        symbol: this.symbol.toLowerCase(),
      }));
      this.ws.close();
      this.ws = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
```

### Usage

```typescript
const book = new OrderBookManager("BTC-USD");
await book.start(() => {
  const { bids, asks } = book.getSnapshot();
  // Render bids and asks
  console.log("Best bid:", bids[0], "Best ask:", asks[0]);
});

// Estimate fill price for a 0.5 BTC long market order
const vwap = book.estimateFillPrice("Long", 0.5);
console.log("Estimated fill:", vwap);

// Cleanup
book.destroy();
```
