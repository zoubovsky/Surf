---
name: strike-deposit
description: Strike Finance deposit flow — get quotes, build transactions, confirm deposits. Use when implementing multi-chain deposit functionality.
---

# Strike Finance Deposit Flow

Deposits follow a 3-step flow: get a quote, build the on-chain transaction, then confirm after the user signs and submits.

## Step 1: Get Quote

```
POST /v2/deposit/quote
```

**Body:**

```json
{
  "blockchain": "ethereum",
  "symbol": "USDC",
  "amount": "1000000"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `blockchain` | string | `"ethereum"` \| `"solana"` \| `"cardano"` |
| `symbol` | string | `"USDC"` \| `"ADA"` \| `"SOL"` \| `"ETH"` |
| `amount` | string | Amount in smallest units (e.g., 1 USDC = `"1000000"` for 6 decimals) |

**Response:**

```json
{
  "exchange_rate": "1.0001",
  "usd_amount": "1000.00",
  "vault_address": "0xVaultAddress...",
  "quote_expires_at": "2025-01-15T00:05:00Z",
  "request_id": "req_abc123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `exchange_rate` | string | Conversion rate from asset to USD |
| `usd_amount` | string | USD value that will be credited |
| `vault_address` | string | On-chain vault address to deposit to |
| `quote_expires_at` | string | ISO 8601 expiration time for this quote |
| `request_id` | string | Unique identifier for this deposit flow |

## Step 2: Build Transaction

```
POST /v2/deposit/build-tx
```

**Body:**

```json
{
  "request_id": "req_abc123",
  "blockchain": "ethereum"
}
```

**Response (chain-specific unsigned transaction):**

### EVM (Ethereum)

```json
{
  "to": "0xVaultContractAddress",
  "data": "0xCalldata...",
  "value": "0"
}
```

### Solana

```json
{
  "transaction": "base64EncodedTransaction..."
}
```

### Cardano

```json
{
  "tx_body_hex": "cborHexEncodedTxBody..."
}
```

## User Signs and Submits On-Chain

Between steps 2 and 3, the user must:

1. Sign the unsigned transaction with their wallet
2. Submit the signed transaction to the blockchain
3. Obtain the transaction hash

## Step 3: Confirm Deposit

```
POST /v2/deposit
```

**Body:**

```json
{
  "request_id": "req_abc123",
  "transaction_hash": "0xTransactionHash..."
}
```

**Response:**

```json
{
  "deposit_id": "dep_xyz789",
  "status": "pending",
  "blockchain_confirmations": 0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deposit_id` | string | Unique deposit identifier |
| `status` | string | `"pending"` \| `"confirmed"` |
| `blockchain_confirmations` | number | Number of on-chain confirmations received |

## Full TypeScript Example

```typescript
import { authenticatedFetch } from "./auth";

const BASE_URL = "https://api.strikefinance.org";

async function deposit(
  blockchain: "ethereum" | "solana" | "cardano",
  symbol: string,
  amount: string,
  privateKey: Uint8Array,
  publicKeyHex: string,
  walletSigner: (tx: any) => Promise<string> // returns tx hash
): Promise<{ deposit_id: string; status: string }> {
  // Step 1: Get quote
  const quoteRes = await authenticatedFetch(
    BASE_URL,
    "/v2/deposit/quote",
    {
      method: "POST",
      body: { blockchain, symbol, amount },
    },
    privateKey,
    publicKeyHex
  );
  const quote = await quoteRes.json();
  console.log(`Quote: ${quote.usd_amount} USD, expires ${quote.quote_expires_at}`);

  // Step 2: Build unsigned transaction
  const buildRes = await authenticatedFetch(
    BASE_URL,
    "/v2/deposit/build-tx",
    {
      method: "POST",
      body: { request_id: quote.request_id, blockchain },
    },
    privateKey,
    publicKeyHex
  );
  const unsignedTx = await buildRes.json();

  // User signs and submits the transaction on-chain
  const transactionHash = await walletSigner(unsignedTx);

  // Step 3: Confirm deposit
  const confirmRes = await authenticatedFetch(
    BASE_URL,
    "/v2/deposit",
    {
      method: "POST",
      body: { request_id: quote.request_id, transaction_hash: transactionHash },
    },
    privateKey,
    publicKeyHex
  );
  return confirmRes.json();
}
```
