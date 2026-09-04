---
name: strike-auth
description: Strike Finance API authentication — builder connect, API wallet signing, Ed25519 keypairs. Use when implementing auth, sign up, or request signing.
---

# Strike Finance Authentication

## API Servers

| Environment | Base URL |
|-------------|----------|
| Mainnet | `https://api.strikefinance.org` |
| Testnet | `https://api-v2-testnet.strikefinance.org` |

## Ed25519 Keypair Generation

Generate a keypair using `@noble/ed25519` for API wallet signing:

```typescript
import * as ed from "@noble/ed25519";

const privateKey = ed.utils.randomPrivateKey(); // 32 bytes
const publicKey = await ed.getPublicKeyAsync(privateKey); // 32 bytes
const publicKeyHex = Buffer.from(publicKey).toString("hex"); // 64 hex chars
```

## Builder Connect Flow

### Step 1: Request Signature

```
POST /auth/builder/request-signature
```

**Body:**

```json
{
  "address": "0xYourWalletAddress",
  "chain": "ethereum",
  "public_key": "64-char-hex-ed25519-public-key",
  "code": "your-builder-code",
  "max_fee_bps": 50
}
```

- `chain` — `"ethereum"` | `"solana"` | `"cardano"`
- `public_key` — 64 hex character Ed25519 public key
- `max_fee_bps` — 0 to 100 (basis points)

**Response:**

```json
{
  "nonce": "abc123",
  "message_to_sign": "Sign this message to connect..."
}
```

### Step 2: Verify Signature

```
POST /auth/builder/verify-signature
```

**Body:**

```json
{
  "address": "0xYourWalletAddress",
  "chain": "ethereum",
  "nonce": "abc123",
  "wallet_signature": "0xSignedMessage..."
}
```

**Response:**

```json
{
  "account_id": "acc_abc123",
  "builder_code": "your-builder-code",
  "max_fee_bps": 50,
  "api_wallet_id": "aw_xyz789",
  "api_wallet_public_key": "64-char-hex-public-key",
  "api_wallet_created_at": "2025-01-15T00:00:00Z"
}
```

## API Wallet Auth Headers

All subsequent authenticated requests must include these headers:

| Header | Format | Example |
|--------|--------|---------|
| `X-API-Wallet-Public-Key` | 64 hex chars | `a1b2c3...` |
| `X-API-Wallet-Signature` | 128 hex chars (Ed25519) | `d4e5f6...` |
| `X-API-Wallet-Timestamp` | Unix seconds | `1700000000` |
| `X-API-Wallet-Nonce` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |

## Signature Message Format

```
{METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}
```

- `METHOD` — uppercase HTTP method (GET, POST, PUT, DELETE)
- `PATH` — request path (e.g., `/v2/account`)
- `TIMESTAMP` — Unix seconds as string
- `NONCE` — UUID v4
- `BODY_HASH` — SHA-256 hex digest of the JSON body; use empty string `""` for GET requests

## TypeScript Code Example

```typescript
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { createHash, randomUUID } from "crypto";

// Required for @noble/ed25519
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

interface AuthHeaders {
  "X-API-Wallet-Public-Key": string;
  "X-API-Wallet-Signature": string;
  "X-API-Wallet-Timestamp": string;
  "X-API-Wallet-Nonce": string;
}

function signRequest(
  method: string,
  path: string,
  body: string | undefined,
  privateKey: Uint8Array,
  publicKeyHex: string
): AuthHeaders {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");

  const message = `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = ed.sign(messageBytes, privateKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  return {
    "X-API-Wallet-Public-Key": publicKeyHex,
    "X-API-Wallet-Signature": signatureHex,
    "X-API-Wallet-Timestamp": timestamp,
    "X-API-Wallet-Nonce": nonce,
  };
}

async function authenticatedFetch(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: object },
  privateKey: Uint8Array,
  publicKeyHex: string
): Promise<Response> {
  const method = options.method ?? "GET";
  const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

  const headers = signRequest(method, path, bodyStr, privateKey, publicKeyHex);

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: bodyStr,
  });

  if (response.status === 401) {
    // Clear stored credentials
    window.dispatchEvent(new Event("strike:session-expired"));
  }

  return response;
}
```

## Session Expiry Handling

On receiving a `401 Unauthorized` response:

1. Clear all stored credentials (private key, public key)
2. Dispatch a `"strike:session-expired"` custom event on `window`
3. Redirect the user to re-authenticate

```typescript
window.addEventListener("strike:session-expired", () => {
  localStorage.removeItem("strike_api_wallet_private_key");
  localStorage.removeItem("strike_api_wallet_public_key");
  // Redirect to connect page or show re-auth modal
});
```
