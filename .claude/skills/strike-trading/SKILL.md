---
name: strike-trading
description: Strike Finance order management -- create, cancel, replace orders, bracket strategies, TWAP, leverage, margin. Use when building trading bots or order interfaces.
---

# Strike Finance Trading

Base URL: `https://api.strikefinance.org`

All endpoints require API wallet auth headers.

---

## Endpoints

### POST /v2/order -- Create Order

**Required fields:**
- `symbol` (string) -- e.g. `"BTC-USD"`
- `side` -- `"buy"` | `"sell"`
- `type` -- `"limit"` | `"market"` | `"stop"` | `"stop_limit"` | `"take_profit"` | `"take_profit_limit"` | `"trailing_stop_market"`
- `size` (string) -- e.g. `"0.1"`

**Optional fields:**
- `price` -- limit price
- `stop_price` -- trigger price for stop/TP orders
- `time_in_force` -- `"GTC"` | `"IOC"` | `"FOK"` (default `GTC`)
- `working_type` -- `"mark_price"` | `"contract_price"` (default `mark_price`)
- `post_only` (bool)
- `reduce_only` (bool)
- `close_position` (bool)
- `price_protect` (bool)
- `vault_id`
- `callback_rate` -- trailing stop callback rate, `"0.1"` to `"5"`
- `activation_price` -- trailing stop activation price
- `slippage` (decimal) -- e.g. `"0.05"` = 5%
- `client_order_id`

**Response (201):**
```json
{
  "client_order_id": "...",
  "account_id": "...",
  "symbol": "BTC-USD",
  "sequence_id": 123,
  "message_id": "..."
}
```

---

### GET /v2/order -- Get Order by ID

Query params:
- `symbol` (required)
- `order_id` or `client_order_id`
- `vault_id`

---

### DELETE /v2/order/cancel -- Cancel Order

Body:
```json
{
  "order_id": "...",
  "symbol": "BTC-USD",
  "vault_id": "optional"
}
```

---

### DELETE /v2/order/cancel-all -- Cancel All Orders

Body:
```json
{
  "symbol": "BTC-USD",
  "vault_id": "optional"
}
```

Response includes `canceled_count` (`-1` means async processing).

---

### POST /v2/order/replace -- Atomic Cancel + Create

Body:
```json
{
  "cancel": {
    "order_id": "...",
    "symbol": "BTC-USD"
  },
  "new_order": { /* CreateOrderRequest */ },
  "vault_id": "optional"
}
```

---

### POST /v2/order/replace-batch -- Batch Replace

Body:
```json
{
  "replacements": [
    {
      "cancel": { "order_id": "...", "symbol": "BTC-USD" },
      "new_order": { /* CreateOrderRequest */ }
    }
  ],
  "vault_id": "optional"
}
```

All-or-nothing cancel -- if any cancel fails, entire batch is rejected.

---

### POST /v2/orders/batch -- Batch Create

Body:
```json
{
  "orders": [ /* CreateOrderRequest[] */ ],
  "vault_id": "optional"
}
```

Independent execution -- partial success is OK.

Response:
```json
{
  "successful": [ /* order responses */ ],
  "failed": [
    { "index": 0, "error": "..." }
  ]
}
```

---

### POST /v2/order/strategy -- Bracket Order (TP/SL)

Body:
```json
{
  "strategy_id": "...",
  "client_order_id": "...",
  "symbol": "BTC-USD",
  "side": "buy",
  "type": "limit",
  "size": "0.1",
  "price": "50000",
  "tp_order": {
    "type": "take_profit",
    "size": "0.1",
    "stop_price": "55000",
    "price": "55000",
    "time_in_force": "GTC",
    "working_type": "mark_price",
    "post_only": false,
    "price_protect": false
  },
  "sl_order": {
    "type": "stop",
    "size": "0.1",
    "stop_price": "48000",
    "price": "48000",
    "time_in_force": "GTC",
    "working_type": "mark_price",
    "post_only": false,
    "price_protect": false
  }
}
```

At least one of `tp_order` or `sl_order` is required. TP/SL orders are placed after the primary order fills. One cancels the other (OCO behavior).

---

### GET /v2/openOrders -- All Open Orders

Query params:
- `symbol` (optional)
- `vault_id` (optional)

---

### POST /v2/leverage -- Update Leverage

Body:
```json
{
  "symbol": "BTC-USD",
  "leverage": 10,
  "vault_id": "optional"
}
```

Leverage range: 1-125. Affects new positions only.

Response:
```json
{
  "leverage": 10,
  "maxNotionalValue": "...",
  "symbol": "BTC-USD"
}
```

---

### POST /v2/marginMode -- Switch Margin Mode

Body:
```json
{
  "symbol": "BTC-USD",
  "marginMode": "cross",
  "vault_id": "optional"
}
```

Values: `"cross"` | `"isolated"`. Cannot change with an open position.

---

### POST /v2/isoMargin -- Modify Isolated Margin

Body:
```json
{
  "symbol": "BTC-USD",
  "amount": "100",
  "modify_type": "add",
  "vault_id": "optional"
}
```

Values for `modify_type`: `"add"` | `"remove"`.

---

### POST /v2/algo/twap -- Create TWAP

Body:
```json
{
  "symbol": "BTC-USD",
  "side": "BUY",
  "total_size": "1.0",
  "duration_sec": 3600,
  "limit_price": "50000",
  "reduce_only": false,
  "randomize": true
}
```

- `side`: `"BUY"` | `"SELL"`
- `duration_sec`: 300 to 86400
- `limit_price`, `reduce_only`, `randomize` are optional
- Max 20 concurrent TWAP strategies per account

---

### GET /v2/algo/twap -- List TWAP Strategies

Query: `status` -- `"active"` | `"all"` | specific status

---

### GET /v2/algo/twap/{id} -- Get Single TWAP

---

### DELETE /v2/algo/twap/{id} -- Cancel TWAP

Transitions strategy to `"cancelling"` status.

---

## Examples

### Market Buy

```json
POST /v2/order
{
  "symbol": "BTC-USD",
  "side": "buy",
  "type": "market",
  "size": "0.1",
  "slippage": "0.05"
}
```

### Limit Sell

```json
POST /v2/order
{
  "symbol": "BTC-USD",
  "side": "sell",
  "type": "limit",
  "size": "0.5",
  "price": "70000",
  "time_in_force": "GTC",
  "post_only": true
}
```

### Stop Loss

```json
POST /v2/order
{
  "symbol": "BTC-USD",
  "side": "sell",
  "type": "stop",
  "size": "0.1",
  "stop_price": "48000",
  "working_type": "mark_price",
  "reduce_only": true
}
```

### Trailing Stop

```json
POST /v2/order
{
  "symbol": "BTC-USD",
  "side": "sell",
  "type": "trailing_stop_market",
  "size": "0.1",
  "callback_rate": "1.5",
  "activation_price": "55000",
  "reduce_only": true
}
```

### Bracket Order with TP/SL

```json
POST /v2/order/strategy
{
  "symbol": "BTC-USD",
  "side": "buy",
  "type": "limit",
  "size": "0.1",
  "price": "50000",
  "tp_order": {
    "type": "take_profit",
    "size": "0.1",
    "stop_price": "55000"
  },
  "sl_order": {
    "type": "stop",
    "size": "0.1",
    "stop_price": "48000"
  }
}
```

### TWAP

```json
POST /v2/algo/twap
{
  "symbol": "BTC-USD",
  "side": "BUY",
  "total_size": "5.0",
  "duration_sec": 3600,
  "limit_price": "52000",
  "randomize": true
}
```

---

## Order Statuses

| Status | Description |
|--------|-------------|
| `pending` | Order submitted, not yet acknowledged |
| `open` | Active on the order book |
| `filled` | Fully executed |
| `canceled` | Canceled by user or system |
| `untriggered` | Stop/TP order waiting for trigger |
| `rejected` | Rejected by matching engine |
| `expired` | Expired (e.g. FOK not filled) |

## Auto Close Types

| Type | Description |
|------|-------------|
| `liquidation` | Position liquidated |
| `adl` | Auto-deleveraged |
| `bankrupt` | Bankruptcy close |
| `if_transfer` | Insurance fund transfer |
