---
name: strike-withdraw
description: Strike Finance withdrawal flow — get quotes, sign messages, confirm withdrawals. Use when implementing withdrawal functionality.
---

# Strike Finance Withdrawal Flow

Withdrawals follow a 2-step flow: get a quote (which includes a message to sign), then confirm with the wallet signature. The backend uses the registered wallet address as the recipient -- there is no recipient parameter.

## Step 1: Get Quote

```
POST /v2/withdraw/quote
```

**Body:**

```json
{
  "blockchain": "ethereum",
  "usd_amount": "500.00",
  "asset": "USDC"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blockchain` | string | Yes | `"ethereum"` \| `"solana"` \| `"cardano"` |
| `usd_amount` | string | Yes | USD amount to withdraw |
| `asset` | string | No | Optional asset to receive (defaults to chain native or USDC) |

**Response:**

```json
{
  "withdraw_id": "wd_abc123",
  "fee": "0.50",
  "message_to_sign": "Strike Finance Withdrawal\nAmount: 500.00 USD\nWithdraw ID: wd_abc123\nTimestamp: 1700000000",
  "expires_at": "2025-01-15T00:05:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `withdraw_id` | string | Unique withdrawal identifier |
| `fee` | string | Withdrawal fee in USD |
| `message_to_sign` | string | Message the user must sign with their wallet |
| `expires_at` | string | ISO 8601 expiration time for this quote |

## Step 2: Confirm Withdrawal

```
POST /v2/withdraw
```

**Body:**

```json
{
  "withdraw_id": "wd_abc123",
  "wallet_signature": "0xSignedMessage..."
}
```

**Response:**

```json
{
  "withdraw_id": "wd_abc123",
  "status": "pending",
  "amount_received": "499.50"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `withdraw_id` | string | Unique withdrawal identifier |
| `status` | string | `"pending"` \| `"confirmed"` |
| `amount_received` | string | Amount after fees that will be sent to the wallet |

## Chain-Specific Signature Formats

The `wallet_signature` field in the confirm step must match the chain's signing standard:

| Chain | Signature Format | Details |
|-------|-----------------|---------|
| Ethereum | EIP-191 hex | `personal_sign` result, hex-encoded with `0x` prefix |
| Solana | Ed25519 base58 | Raw Ed25519 signature, base58-encoded |
| Cardano | CIP-30 COSE | COSE_Sign1 structure per CIP-30 `signData` |

### Ethereum (EIP-191)

```typescript
// Using ethers.js or window.ethereum
const signature = await signer.signMessage(messageToSign);
// Returns: "0x..." (hex-encoded, 132 chars)
```

### Solana (Ed25519 base58)

```typescript
// Using @solana/wallet-adapter
const encoded = new TextEncoder().encode(messageToSign);
const signatureBytes = await wallet.signMessage(encoded);
const signature = bs58.encode(signatureBytes);
// Returns: base58 string
```

### Cardano (CIP-30 COSE)

```typescript
// Using CIP-30 wallet API
const hexMessage = Buffer.from(messageToSign).toString("hex");
const signature = await wallet.signData(stakeAddress, hexMessage);
// Returns: COSE_Sign1 hex string
```

## Full TypeScript Example

```typescript
import { authenticatedFetch } from "./auth";

const BASE_URL = "https://api.strikefinance.org";

type WalletSigner = (message: string) => Promise<string>;

async function withdraw(
  blockchain: "ethereum" | "solana" | "cardano",
  usdAmount: string,
  privateKey: Uint8Array,
  publicKeyHex: string,
  walletSign: WalletSigner,
  asset?: string
): Promise<{ withdraw_id: string; status: string; amount_received: string }> {
  // Step 1: Get quote
  const quoteRes = await authenticatedFetch(
    BASE_URL,
    "/v2/withdraw/quote",
    {
      method: "POST",
      body: { blockchain, usd_amount: usdAmount, ...(asset ? { asset } : {}) },
    },
    privateKey,
    publicKeyHex
  );
  const quote = await quoteRes.json();
  console.log(`Withdraw fee: ${quote.fee} USD, expires ${quote.expires_at}`);

  // User signs the message with their wallet
  const walletSignature = await walletSign(quote.message_to_sign);

  // Step 2: Confirm withdrawal
  const confirmRes = await authenticatedFetch(
    BASE_URL,
    "/v2/withdraw",
    {
      method: "POST",
      body: { withdraw_id: quote.withdraw_id, wallet_signature: walletSignature },
    },
    privateKey,
    publicKeyHex
  );
  return confirmRes.json();
}

// Usage with Ethereum
async function withdrawEth(signer: any, amount: string) {
  const walletSign = async (message: string) => {
    return await signer.signMessage(message);
  };
  return withdraw("ethereum", amount, apiPrivateKey, apiPublicKeyHex, walletSign, "USDC");
}

// Usage with Solana
async function withdrawSol(wallet: any, amount: string) {
  const walletSign = async (message: string) => {
    const encoded = new TextEncoder().encode(message);
    const sig = await wallet.signMessage(encoded);
    return bs58.encode(sig);
  };
  return withdraw("solana", amount, apiPrivateKey, apiPublicKeyHex, walletSign);
}

// Usage with Cardano
async function withdrawAda(wallet: any, stakeAddress: string, amount: string) {
  const walletSign = async (message: string) => {
    const hex = Buffer.from(message).toString("hex");
    return await wallet.signData(stakeAddress, hex);
  };
  return withdraw("cardano", amount, apiPrivateKey, apiPublicKeyHex, walletSign, "ADA");
}
```
