---
name: strike-trades
description: Strike Finance trades — real-time market trades via WebSocket, historical fills via REST. Use when building trade feeds or execution history.
---

# Strike Finance Trades

Real-time public market trades and authenticated user fill history. Supports both WebSocket streaming and REST pagination.

## Market Trades (Public)

### REST Endpoint

**GET** `https://api.strikefinance.org/price/v2/trades?symbol=BTC-USD&limit=50`

Returns recent market trades for the given symbol.

### WebSocket

**URL:** `wss://api.strikefinance.org/ws/price` (public, no auth)

#### Subscribe

```json
{"id": 1713960000000, "method": "subscribe", "channel": "trade", "symbol": "btc-usd"}
```

**Symbol must be lowercase** in subscribe/unsubscribe messages.

#### Unsubscribe

```json
{"id": 1713960000000, "method": "unsubscribe", "channel": "trade", "symbol": "btc-usd"}
```

#### Event Format

```typescript
interface TradeEvent {
  e: "trade";
  s: string;    // symbol, e.g. "BTC-USD"
  t: number;    // tradeId
  T: number;    // trade time (ms)
  p: string;    // price, e.g. "45000.00"
  q: string;    // quantity, e.g. "0.1"
  m: boolean;   // isBuyerMaker — true means the seller is the taker (price moved down)
  o: number;    // orderId
}
```

- `m: true` = seller is taker (sell aggressor, red trade)
- `m: false` = buyer is taker (buy aggressor, green trade)
- Cap the display at **50 trades** maximum; prepend new trades to the array.

## User Fills (Authenticated)

### REST Endpoint

**GET** `https://api.strikefinance.org/v2/history/fill`

Query parameters:

| Param | Type | Description |
|-------|------|-------------|
| `account_id` | string | Required. User account ID. |
| `symbol` | string | Optional. Filter by symbol, e.g. `BTC-USD`. |
| `limit` | number | Optional. Max results per page (default 20). |
| `fromId` | number | Optional. Backward cursor — returns fills with `id < fromId`. |
| `since_trade_id` | number | Optional. Forward cursor — returns fills with `trade_id > since_trade_id`. |

### Fill Object

```typescript
interface Fill {
  id: number;
  trade_id: number;
  order_id: number;
  account_id: number;
  symbol: string;           // e.g. "BTC-USD"
  side: string;             // "buy" | "sell"
  role: "maker" | "taker";
  price: string;
  size: string;
  realized_pnl: string;
  fee: string;
  fee_type: string;
  auto_close_type: "" | "liquidation" | "ADL";
  timestamp: number;        // ms
}
```

### Pagination

- **Backward (older):** pass `fromId` set to the smallest `id` in the current page.
- **Forward (newer):** pass `since_trade_id` set to the largest `trade_id` in the current page.

### Real-Time User Fills

Real-time fill updates arrive via the authenticated user stream WebSocket (see `strike-userstream` skill). They come as `ORDER_TRADE_UPDATE` events where `tradeId > 0` indicates an actual fill occurred.

## Deduplication

- Deduplicate by `trade_id` (for market trades) or `id` (for user fills).
- New trade: **prepend** to the array.
- Existing trade (matching ID): **merge/update** in place.

## Full Implementation Example

```typescript
interface Trade {
  tradeId: number;
  time: number;
  price: string;
  quantity: string;
  isBuyerMaker: boolean;
}

class TradeManager {
  private trades: Trade[] = [];
  private tradeIds = new Set<number>();
  private ws: WebSocket | null = null;
  private readonly MAX_TRADES = 50;

  constructor(private symbol: string) {}

  async start(onUpdate: (trades: Trade[]) => void): Promise<void> {
    // Fetch initial trades via REST
    const res = await fetch(
      `https://api.strikefinance.org/price/v2/trades?symbol=${this.symbol}&limit=${this.MAX_TRADES}`
    );
    const initial: TradeEvent[] = await res.json();

    for (const t of initial) {
      this.addTrade({
        tradeId: t.t,
        time: t.T,
        price: t.p,
        quantity: t.q,
        isBuyerMaker: t.m,
      });
    }
    onUpdate([...this.trades]);

    // Connect WebSocket for real-time trades
    this.ws = new WebSocket("wss://api.strikefinance.org/ws/price");

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        id: Date.now(),
        method: "subscribe",
        channel: "trade",
        symbol: this.symbol.toLowerCase(),
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.e !== "trade") return;

      const trade: Trade = {
        tradeId: data.t,
        time: data.T,
        price: data.p,
        quantity: data.q,
        isBuyerMaker: data.m,
      };

      if (this.addTrade(trade)) {
        onUpdate([...this.trades]);
      }
    };
  }

  private addTrade(trade: Trade): boolean {
    // Deduplication by tradeId
    if (this.tradeIds.has(trade.tradeId)) {
      // Merge/update existing trade in place
      const idx = this.trades.findIndex((t) => t.tradeId === trade.tradeId);
      if (idx !== -1) {
        this.trades[idx] = trade;
      }
      return true;
    }

    // Prepend new trade
    this.tradeIds.add(trade.tradeId);
    this.trades.unshift(trade);

    // Cap at MAX_TRADES
    while (this.trades.length > this.MAX_TRADES) {
      const removed = this.trades.pop()!;
      this.tradeIds.delete(removed.tradeId);
    }

    return true;
  }

  getTrades(): Trade[] {
    return [...this.trades];
  }

  destroy(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({
        id: Date.now(),
        method: "unsubscribe",
        channel: "trade",
        symbol: this.symbol.toLowerCase(),
      }));
      this.ws.close();
      this.ws = null;
    }
  }
}

// --- User Fill History ---

class FillHistoryManager {
  private fills: Fill[] = [];
  private fillIds = new Set<number>();

  constructor(
    private accountId: string,
    private symbol?: string
  ) {}

  async loadInitial(limit = 20): Promise<Fill[]> {
    const params = new URLSearchParams({
      account_id: this.accountId,
      limit: String(limit),
    });
    if (this.symbol) params.set("symbol", this.symbol);

    const res = await fetch(
      `https://api.strikefinance.org/v2/history/fill?${params}`
    );
    const data: Fill[] = await res.json();

    for (const fill of data) {
      if (!this.fillIds.has(fill.id)) {
        this.fillIds.add(fill.id);
        this.fills.push(fill);
      }
    }

    return [...this.fills];
  }

  async loadOlder(): Promise<Fill[]> {
    if (this.fills.length === 0) return this.loadInitial();

    const oldestId = Math.min(...this.fills.map((f) => f.id));
    const params = new URLSearchParams({
      account_id: this.accountId,
      fromId: String(oldestId),
      limit: "20",
    });
    if (this.symbol) params.set("symbol", this.symbol);

    const res = await fetch(
      `https://api.strikefinance.org/v2/history/fill?${params}`
    );
    const data: Fill[] = await res.json();

    for (const fill of data) {
      if (!this.fillIds.has(fill.id)) {
        this.fillIds.add(fill.id);
        this.fills.push(fill);
      }
    }

    // Sort by timestamp descending (newest first)
    this.fills.sort((a, b) => b.timestamp - a.timestamp);
    return [...this.fills];
  }

  // Call this when receiving ORDER_TRADE_UPDATE from user stream
  addRealtimeFill(fill: Fill): void {
    if (this.fillIds.has(fill.id)) {
      // Update existing
      const idx = this.fills.findIndex((f) => f.id === fill.id);
      if (idx !== -1) this.fills[idx] = fill;
    } else {
      // Prepend new fill
      this.fillIds.add(fill.id);
      this.fills.unshift(fill);
    }
  }

  getFills(): Fill[] {
    return [...this.fills];
  }
}
```

### Usage

```typescript
// Public market trades
const tradeManager = new TradeManager("BTC-USD");
await tradeManager.start((trades) => {
  for (const t of trades.slice(0, 10)) {
    const side = t.isBuyerMaker ? "SELL" : "BUY";
    console.log(`${side} ${t.quantity} @ ${t.price}`);
  }
});

// User fill history
const fills = new FillHistoryManager("12345", "BTC-USD");
const initial = await fills.loadInitial();
console.log("Recent fills:", initial.length);

// Load more history
const older = await fills.loadOlder();
console.log("Total fills:", older.length);

// Cleanup
tradeManager.destroy();
```
