---
name: strike-market-data
description: Strike Finance public market data -- orderbook depth, trades, prices, tickers, klines, open interest. Use when fetching market data or building trading interfaces.
---

# Strike Finance Market Data

Base URL: `https://api.strikefinance.org/price` (mainnet)

All endpoints are PUBLIC -- no authentication required.

---

## WebSocket

Real-time market streams are also PUBLIC -- no authentication required.

| Environment | URL |
|-------------|-----|
| Mainnet | `wss://api.strikefinance.org/ws/price` |
| Testnet | `wss://api-v2-testnet.strikefinance.org/ws/price` |

Subscribe:

```json
{
  "method": "subscribe",
  "channel": "depth",
  "symbol": "BTC-USD",
  "id": 1
}
```

Unsubscribe:

```json
{
  "method": "unsubscribe",
  "channel": "depth",
  "symbol": "BTC-USD",
  "id": 2
}
```

Success response:

```json
{ "result": null, "id": 1 }
```

Client keep-alive:

```json
{ "method": "ping", "id": 99 }
```

Server replies:

```json
{ "method": "pong", "id": 99 }
```

Server WebSocket ping frames are sent every 54 seconds; connections close if no pong is received within 60 seconds. Most WebSocket libraries answer protocol-level pings automatically.

### WebSocket Channels

| Channel | Symbol Required | Frequency | Description |
|---------|-----------------|-----------|-------------|
| `markprice` | Yes | 3 seconds | Mark price, index price, funding rate |
| `!markprice@arr` | No | 3 seconds | Mark prices for all symbols |
| `kline_{interval}` | Yes | Real-time | Candlestick stream |
| `miniticker` | Yes | 1 second | 24h mini ticker for one symbol |
| `!miniticker@arr` | No | 1 second | 24h mini tickers for all symbols |
| `depth` | Yes | Real-time | Order book deltas |
| `trade` | Yes | Real-time | Public trade stream |

Available kline intervals: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`.

### WebSocket Event Shapes

Depth deltas:

```json
{
  "e": "depthUpdate",
  "E": 1704067200000,
  "s": "BTC-USD",
  "U": 128742991,
  "u": 128742991,
  "b": [["94249.50", "2.5"], ["94247.00", "0"]],
  "a": [["94251.00", "1.8"]]
}
```

- `U` and `u` are uint64 engine sequence IDs; parse as `BigInt` in JavaScript/TypeScript.
- `U`/`u` are globally monotonic, not per-symbol contiguous. Do not treat gaps as missed updates.
- Quantity `"0"` removes the price level.
- To maintain a local order book: fetch `GET /price/v2/depth?symbol=BTC-USD&limit=1000`, subscribe to `depth`, buffer events while the snapshot loads, drop events with `u <= lastUpdateId`, then apply later deltas and set `lastUpdateId = u`.

Mark price:

```json
{
  "e": "markPriceUpdate",
  "E": 1704067200000,
  "s": "BTC-USD",
  "p": "94250.50",
  "i": "94248.00",
  "P": "0",
  "r": "0.0001",
  "T": 1704070800000
}
```

Trade:

```json
{
  "e": "trade",
  "E": 1704067200000,
  "s": "BTC-USD",
  "t": 123456789,
  "p": "94250.50",
  "q": "0.5",
  "T": 1704067200000,
  "m": false
}
```

Kline events use channel `kline_{interval}` and return `e: "kline"` with nested `k` fields (`t`, `T`, `s`, `i`, `o`, `c`, `h`, `l`, `v`, `n`, `x`, `q`, `V`, `Q`). Mini ticker events use `e: "24hrMiniTicker"` and fields `c`, `o`, `h`, `l`, `v`, `q`.

---

## Endpoints

### GET /v2/depth -- Orderbook Depth

Query params:
- `symbol` (required) -- e.g. `"BTC-USD"`
- `limit` -- 1 to 1000, default 20

Response:
```json
{
  "lastUpdateId": 1234567890123456789,
  "E": 1700000000000,
  "T": 1700000000000,
  "bids": [["50000.00", "1.5"], ["49999.00", "2.0"]],
  "asks": [["50001.00", "0.8"], ["50002.00", "1.2"]]
}
```

- `lastUpdateId` (uint64) -- **can exceed Number.MAX_SAFE_INTEGER, always use BigInt**
- `E` -- event time in milliseconds
- `T` -- transaction time in milliseconds
- `bids` -- string[][] sorted highest first (price, quantity)
- `asks` -- string[][] sorted lowest first (price, quantity)
- Cached 5s server-side. Check `X-Cache` response header (`HIT` or `MISS`).

---

### GET /v2/trades -- Recent Trades

Query params:
- `symbol` (required)
- `limit` (optional)

---

### GET /v2/markPrice -- Mark Price

Query params:
- `symbol` (optional) -- omit for all symbols

Response:
```json
{
  "symbol": "BTC-USD",
  "markPrice": "50123.45",
  "indexPrice": "50120.00",
  "estimatedSettlePrice": "50122.00",
  "lastFundingRate": "0.0001",
  "nextFundingTime": 1700003600000,
  "interestRate": "0.0001",
  "time": 1700000000000
}
```

---

### GET /v2/ticker/24hr -- 24h Ticker Statistics

Query params:
- `symbol` (required)

---

### GET /v2/ticker/bookTicker -- Best Bid/Ask

Query params:
- `symbol` (optional) -- omit for all symbols

---

### GET /v2/exchangeInfo -- Exchange Info

Returns markets, trading rules, and filters. No query params required.

---

### GET /v2/klines -- Candlestick / Kline Data

Query params:
- `symbol` (required)
- `interval` -- `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` (optional)

---

### GET /v2/openInterest -- Open Interest

Query params:
- `symbol` (required)

---

## Important Notes

- **BigInt required**: `lastUpdateId` in depth responses can exceed `Number.MAX_SAFE_INTEGER`. Always parse with `BigInt`.
- **Caching**: Depth endpoint is cached for 5 seconds server-side. Use the `X-Cache` response header to detect `HIT` vs `MISS`.
- **Real-time data**: Prefer the public market WebSocket for live updates and REST for snapshots/backfill.
