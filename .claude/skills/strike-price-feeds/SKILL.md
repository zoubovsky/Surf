---
name: strike-price-feeds
description: Strike Finance real-time price feeds — WebSocket channels for mark prices, trades, depth, tickers, klines. Use when building real-time trading interfaces or price monitors.
---

# Strike Finance Real-time Price Feeds

## WebSocket URLs

| Endpoint | URL | Auth |
|----------|-----|------|
| Public | `wss://api.strikefinance.org/ws/price` | None required |
| User | `wss://api.strikefinance.org/ws/user-api` | API wallet signing |

## Subscription Format

```json
{"id": <timestamp>, "method": "subscribe", "channel": "<channel>", "symbol": "<symbol>"}
```

Unsubscribe uses the same format with `"method": "unsubscribe"`.

**Symbol format:** Use lowercase for subscribe (e.g. `"btc-usd"`). Events arrive with UPPERCASE symbols (e.g. `"BTC-USD"`).

## Available Channels

### 1. markPrice — Per-symbol mark price + funding

```json
{
  "e": "markPriceUpdate",
  "E": 1234567890000,
  "s": "BTC-USD",
  "p": "45000",
  "i": "44990",
  "P": "45010",
  "r": "0.0001",
  "T": 1234567890000
}
```

| Field | Description |
|-------|-------------|
| `p` | Mark price |
| `i` | Index price |
| `P` | Settlement price |
| `r` | Funding rate |
| `T` | Next funding time (ms) |

### 2. trade — Per-symbol market trades

```json
{
  "e": "trade",
  "s": "BTC-USD",
  "t": 12345,
  "T": 1234567890000,
  "p": "45000",
  "q": "0.1",
  "m": true,
  "o": 67890
}
```

| Field | Description |
|-------|-------------|
| `t` | Trade ID |
| `T` | Timestamp (ms) |
| `p` | Price |
| `q` | Quantity |
| `m` | Is buyer maker |
| `o` | Order ID |

### 3. depth — Per-symbol orderbook deltas

```json
{
  "e": "depthUpdate",
  "s": "BTC-USD",
  "u": 99999,
  "b": [["45000", "1.5"], ["44999", "2.0"]],
  "a": [["45001", "0.8"], ["45002", "1.2"]]
}
```

| Field | Description |
|-------|-------------|
| `u` | Update ID |
| `b` | Bids array `[[price, qty], ...]` |
| `a` | Asks array `[[price, qty], ...]` |

### 4. kline_{interval} — Per-symbol candlestick bars

Available intervals: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`

Subscribe with channel `kline_1m`, `kline_5m`, etc.

```json
{
  "e": "kline",
  "k": {
    "s": "BTC-USD",
    "t": 1234567860000,
    "i": "1m",
    "o": "44900",
    "h": "45100",
    "l": "44850",
    "c": "45000",
    "v": "150.5"
  }
}
```

### 5. !miniTicker@arr — Broadcast 24h mini tickers for ALL symbols

No symbol parameter needed. Subscribe to channel `!miniTicker@arr`.

```json
{
  "e": "24hrMiniTicker",
  "s": "BTC-USD",
  "c": "45000",
  "o": "44000",
  "h": "46000",
  "l": "43500",
  "v": "1000",
  "q": "45000000"
}
```

| Field | Description |
|-------|-------------|
| `c` | Close price |
| `o` | Open price |
| `h` | 24h high |
| `l` | 24h low |
| `v` | Base volume |
| `q` | Quote volume |

Events arrive as an array or single object.

## Reconnection Pattern

- **Exponential backoff:** `delay = min(30000, 1000 * 2^attempt)`
- **Tab visibility:** When tab becomes visible and WS is not OPEN, reconnect immediately
- **Resubscribe:** Replay all active channel subscriptions on reconnect

## Reference Counting

Track subscription count per symbol. Only send unsubscribe to the WS when the count reaches 0. This prevents one component from killing another component's subscription.

## TypeScript Example

```typescript
type Channel = "markPrice" | "trade" | "depth" | `kline_${string}` | "!miniTicker@arr";

interface Subscription {
  channel: Channel;
  symbol?: string;
}

class StrikePriceFeed {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, number>(); // key -> refcount
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30000;

  constructor(private url = "wss://api.strikefinance.org/ws/price") {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("Connected to Strike price feed");
      this.reconnectAttempt = 0;
      this.resubscribeAll();
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("WS error:", err);
    };
  }

  subscribe(channel: Channel, symbol?: string): void {
    const key = symbol ? `${channel}:${symbol}` : channel;
    const count = this.subscriptions.get(key) || 0;
    this.subscriptions.set(key, count + 1);

    if (count === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(channel, symbol);
    }
  }

  unsubscribe(channel: Channel, symbol?: string): void {
    const key = symbol ? `${channel}:${symbol}` : channel;
    const count = this.subscriptions.get(key) || 0;

    if (count <= 1) {
      this.subscriptions.delete(key);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe(channel, symbol);
      }
    } else {
      this.subscriptions.set(key, count - 1);
    }
  }

  private sendSubscribe(channel: Channel, symbol?: string): void {
    const msg: Record<string, unknown> = {
      id: Date.now(),
      method: "subscribe",
      channel,
    };
    if (symbol) msg.symbol = symbol.toLowerCase();
    this.ws?.send(JSON.stringify(msg));
  }

  private sendUnsubscribe(channel: Channel, symbol?: string): void {
    const msg: Record<string, unknown> = {
      id: Date.now(),
      method: "unsubscribe",
      channel,
    };
    if (symbol) msg.symbol = symbol.toLowerCase();
    this.ws?.send(JSON.stringify(msg));
  }

  private resubscribeAll(): void {
    for (const key of this.subscriptions.keys()) {
      const [channel, symbol] = key.split(":") as [Channel, string | undefined];
      this.sendSubscribe(channel, symbol);
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.maxReconnectDelay,
      1000 * Math.pow(2, this.reconnectAttempt)
    );
    this.reconnectAttempt++;
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => this.connect(), delay);
  }

  private handleMessage(data: unknown): void {
    if (Array.isArray(data)) {
      data.forEach((item) => this.routeEvent(item));
    } else {
      this.routeEvent(data as Record<string, unknown>);
    }
  }

  private routeEvent(event: Record<string, unknown>): void {
    switch (event.e) {
      case "markPriceUpdate":
        console.log(`Mark price ${event.s}: ${event.p} | Index: ${event.i}`);
        break;
      case "trade":
        console.log(`Trade ${event.s}: ${event.p} x ${event.q}`);
        break;
      case "depthUpdate":
        console.log(`Depth ${event.s}: ${(event.b as unknown[]).length} bids, ${(event.a as unknown[]).length} asks`);
        break;
      case "kline":
        const k = event.k as Record<string, unknown>;
        console.log(`Kline ${k.s} [${k.i}]: O=${k.o} H=${k.h} L=${k.l} C=${k.c}`);
        break;
      case "24hrMiniTicker":
        console.log(`Ticker ${event.s}: ${event.c} (24h: ${event.l}-${event.h})`);
        break;
    }
  }

  // Handle tab visibility for reconnection
  setupVisibilityHandler(): void {
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        this.ws?.readyState !== WebSocket.OPEN
      ) {
        this.reconnectAttempt = 0;
        this.connect();
      }
    });
  }
}

// Usage
const feed = new StrikePriceFeed();
feed.connect();
feed.setupVisibilityHandler();

// Subscribe to BTC mark price and trades
feed.subscribe("markPrice", "btc-usd");
feed.subscribe("trade", "btc-usd");

// Subscribe to 1-minute klines
feed.subscribe("kline_1m", "btc-usd");

// Subscribe to all tickers (no symbol needed)
feed.subscribe("!miniTicker@arr");

// Later, unsubscribe
feed.unsubscribe("markPrice", "btc-usd");
```
