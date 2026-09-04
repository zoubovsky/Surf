---
name: strike-history
description: Strike Finance history endpoints -- orders, fills, funding, transactions, positions, portfolio. Use when building trade history views or analytics.
---

# Strike Finance History

Base URL: `https://api.strikefinance.org`

All history endpoints support unauthenticated access when `account_id` or `vault_id` is provided.

---

## Endpoints

### GET /v2/history/order -- Order History

Query params:
- `symbol` (optional)
- `status` (optional)
- `order_id` (optional)
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` -- default 100, max 500
- `fromOrderID` -- pagination cursor, returns orders with ID less than this value
- `source` -- e.g. `"twap"`
- `account_id` (optional)
- `vault_id` (optional)

---

### GET /v2/history/fill -- Fill / Trade History

Query params:
- `symbol` (optional)
- `order_id` (optional)
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` -- default 500, max 1000
- `fromId` -- backward pagination cursor
- `since_trade_id` -- forward pagination cursor (**cannot use with `fromId`**)
- `source` -- e.g. `"twap"`
- `account_id` (optional)
- `vault_id` (optional)

Fill response fields:
```json
{
  "id": "...",
  "order_id": "...",
  "symbol": "BTC-USD",
  "side": "buy",
  "price": "50000.00",
  "qty": "0.1",
  "quote_qty": "5000.00",
  "commission": "2.50",
  "commission_asset": "USD",
  "realized_pnl": "0.00",
  "is_maker": true,
  "time": 1700000000000,
  "auto_close_type": null
}
```

---

### GET /v2/history/funding -- Funding History

Query params:
- `symbol` (optional)
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` (optional)
- `fromId` -- pagination cursor

Funding response fields:
```json
{
  "id": "...",
  "symbol": "BTC-USD",
  "income": "1.25",
  "asset": "USD",
  "time": 1700000000000
}
```

- `income` positive = funding received
- `income` negative = funding paid

---

### GET /v2/history/transaction -- Deposit / Withdraw History

Query params:
- `type` -- `"deposit"` | `"withdraw"`
- `limit` (optional)
- `fromId` -- pagination cursor

Transaction response fields:
```json
{
  "id": "...",
  "type": "deposit",
  "status": "completed",
  "amount": "1000.00",
  "asset": "USD",
  "time": 1700000000000
}
```

Transaction types: `deposit`, `withdraw`, `fee`, `realized_pnl`, `liquidation`

Transaction statuses: `pending`, `completed`, `pending_settlement`, `settled`, `failed`, `cancelled`

---

### GET /v2/positions -- Open Positions

Query params:
- `symbol` (optional)
- `position_id` (optional, requires `symbol`)
- `vault_id` (optional)

Response:
```json
{
  "positions": [
    {
      "symbol": "BTC-USD",
      "PositionID": "...",
      "Side": "long",
      "Size": "0.5",
      "EntryPrice": "50000.00",
      "MarginMode": "cross",
      "Leverage": 10,
      "IsolatedMargin": "0",
      "upnl": "250.00",
      "maintenance_margin": "100.00",
      "bankruptcy_price": "45000.00",
      "liquidation_price": "45500.00"
    }
  ],
  "count": 1
}
```

---

### GET /v2/closedPositions -- Closed Positions

Query params:
- `symbol` (optional)
- `startTime` (ms, optional)
- `endTime` (ms, optional)
- `limit` -- max 1000, default 100
- `vault_id` (optional)

Closed position fields:
```json
{
  "symbol": "BTC-USD",
  "position_id": "...",
  "side": "long",
  "size": "0.5",
  "entry_price": "50000.00",
  "exit_price": "52000.00",
  "realized_pnl": "1000.00",
  "margin_mode": "cross",
  "leverage": 10,
  "opened_at": 1699900000000,
  "closed_at": 1700000000000
}
```

---

### GET /v2/openOrders -- Current Open Orders

Query params:
- `symbol` (optional)
- `vault_id` (optional)

---

### GET /v2/portfolio -- Portfolio Summary

Returns account portfolio summary.

---

## Pagination Pattern

All history endpoints use cursor-based pagination:
- Use `fromId` or `fromOrderID` to paginate backward through results
- Use `since_trade_id` for forward pagination (fills only, cannot combine with `fromId`)
- Response includes a `count` field indicating total results in the current page
- To fetch all records, keep requesting with the last ID from the previous response until the result set is empty
