---
name: strike-account
description: Strike Finance account management — create accounts, query balances, update profiles. Use when building account setup or balance displays.
---

# Strike Finance Account Management

## Create Account

```
POST /v2/account
```

Creates a new trading account. Requires authentication headers.

## Get Account Info

```
GET /v2/account
```

**Query Parameters:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `account_id` | string | No | Specify to fetch a particular account |
| `vault_id` | string | No | Fetch vault account (unauthenticated access allowed) |

One of `account_id` or `vault_id` may be provided. If neither is provided, returns the authenticated user's account.

**Response (GetAccountResponse):**

```json
{
  "account_id": "acc_abc123",
  "blockchain": "ethereum",
  "blockchain_address": "0x...",
  "wallet_balance": "10000.00",
  "available_balance": "7500.00",
  "unrealized_pnl": "-250.00",
  "margin_balance": "9750.00",
  "total_margin": "2500.00",
  "position_initial_margin": "2000.00",
  "maintenance_margin": "500.00",
  "symbol_settings": {
    "BTCUSD": {
      "margin_mode": "cross",
      "leverage": 10,
      "allow_pre_trade": true
    },
    "ETHUSD": {
      "margin_mode": "cross",
      "leverage": 5,
      "allow_pre_trade": false
    }
  }
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `account_id` | string | Unique account identifier |
| `blockchain` | string | Blockchain the account is on |
| `blockchain_address` | string | On-chain wallet address |
| `wallet_balance` | string | Total wallet balance (deposits - withdrawals + realized PnL) |
| `available_balance` | string | Balance available for new positions and withdrawals |
| `unrealized_pnl` | string | Unrealized profit/loss across all open positions |
| `margin_balance` | string | wallet_balance + unrealized_pnl |
| `total_margin` | string | Total margin used (initial + maintenance) |
| `position_initial_margin` | string | Initial margin locked in open positions |
| `maintenance_margin` | string | Minimum margin required to keep positions open |
| `symbol_settings` | Record<string, SymbolSettings> | Per-symbol trading configuration |

## Get Balances

```
GET /v2/balances
```

Returns a detailed balance breakdown for the authenticated account.

**Response:**

```json
{
  "walletBalance": "10000.00",
  "unrealizedPnl": "-250.00",
  "marginBalance": "9750.00",
  "maintMargin": "500.00",
  "initialMargin": "2500.00",
  "positionInitialMargin": "2000.00",
  "openOrderInitialMargin": "500.00",
  "crossWalletBalance": "10000.00",
  "crossUnPnl": "-250.00",
  "availableBalance": "7250.00",
  "maxWithdrawAmount": "7250.00",
  "marginAvailable": true,
  "updateTime": 1700000000000
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `walletBalance` | string | Total wallet balance |
| `unrealizedPnl` | string | Unrealized PnL across all positions |
| `marginBalance` | string | walletBalance + unrealizedPnl |
| `maintMargin` | string | Maintenance margin requirement |
| `initialMargin` | string | Total initial margin (positions + orders) |
| `positionInitialMargin` | string | Initial margin for open positions |
| `openOrderInitialMargin` | string | Initial margin reserved for open orders |
| `crossWalletBalance` | string | Cross-margin wallet balance |
| `crossUnPnl` | string | Cross-margin unrealized PnL |
| `availableBalance` | string | Balance available for trading |
| `maxWithdrawAmount` | string | Maximum amount that can be withdrawn |
| `marginAvailable` | boolean | Whether margin is available for new positions |
| `updateTime` | number | Unix timestamp (milliseconds) of last update |

## Get Portfolio

```
GET /v2/portfolio
```

Returns a comprehensive portfolio summary for the authenticated account.

**Response:**

```json
{
  "account": {
    "accountValue": "9750.00",
    "positionValue": "20000.00",
    "availableBalance": "7250.00",
    "allTimePnl": "1500.00",
    "realizedPnl": "1750.00",
    "unrealizedPnl": "-250.00",
    "allTimeVolume": "150000.00"
  },
  "volume": "50000.00",
  "fees": "25.00",
  "history": [
    [1700000000000, "9500.00", "1500.00", "-200.00"],
    [1700086400000, "9750.00", "1750.00", "-250.00"]
  ],
  "feeTier": 1,
  "feeTiers": [
    { "tier": 0, "makerFee": "0.0002", "takerFee": "0.0005", "volumeThreshold": "0" },
    { "tier": 1, "makerFee": "0.00015", "takerFee": "0.0004", "volumeThreshold": "100000" }
  ],
  "volume_history": [],
  "feeDiscountRate": "0.1",
  "isTradingEnabled": true
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `account` | object | Core account metrics |
| `account.accountValue` | string | Total account value (margin balance) |
| `account.positionValue` | string | Notional value of all open positions |
| `account.availableBalance` | string | Available balance for trading |
| `account.allTimePnl` | string | All-time profit/loss |
| `account.realizedPnl` | string | All-time realized PnL |
| `account.unrealizedPnl` | string | Current unrealized PnL |
| `account.allTimeVolume` | string | Total trading volume |
| `volume` | string | Recent trading volume (fee tier period) |
| `fees` | string | Fees paid in the current period |
| `history` | array | Array of [timestamp, accountValue, realizedPnl, unrealizedPnl] |
| `feeTier` | number | Current fee tier level |
| `feeTiers` | array | All available fee tiers with rates and thresholds |
| `volume_history` | array | Historical volume data |
| `feeDiscountRate` | string | Active fee discount rate |
| `isTradingEnabled` | boolean | Whether trading is currently enabled for the account |

## Update Profile

```
POST /v2/account/profile
```

Updates the user's profile. Uses multipart form data.

**Form Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nickname` | string | No | Display name |
| `avatarFile` | File | No | Avatar image file |

**Example:**

```typescript
const formData = new FormData();
formData.append("nickname", "TraderJoe");
formData.append("avatarFile", avatarFile);

await authenticatedFetch(baseUrl, "/v2/account/profile", {
  method: "POST",
  body: formData,
  // Do NOT set Content-Type header — browser sets it with boundary
});
```
