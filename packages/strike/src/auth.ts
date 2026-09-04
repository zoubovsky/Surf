/**
 * Strike Finance API-wallet authentication (Ed25519).
 *
 * REST: every authenticated request carries four headers; the signature is over
 *   `{METHOD}:{PATH_WITH_QUERY}:{TIMESTAMP_SECONDS}:{NONCE}:{SHA256_HEX(body or "")}`
 * The body must be serialised exactly once and sent byte-identical to the hashed string.
 *
 * User WebSocket: `session.logon` signs `session.logon:${timestamp_ms}:${apiKey}` (per the official
 * user-websocket docs). The vendored `strike-userstream` skill documents a different payload
 * (`apiKey=<hex>&timestamp=<ms>`), so the format is selectable; see `LogonMessageFormat`.
 */
import { randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// Enable synchronous signing in @noble/ed25519 v3.
ed.hashes.sha512 = sha512;

export type HexOrBytes = string | Uint8Array;

export interface AuthHeaders {
  "X-API-Wallet-Public-Key": string;
  "X-API-Wallet-Signature": string;
  "X-API-Wallet-Timestamp": string;
  "X-API-Wallet-Nonce": string;
}

export const AUTH_HEADER_PUBLIC_KEY = "X-API-Wallet-Public-Key";
export const AUTH_HEADER_SIGNATURE = "X-API-Wallet-Signature";
export const AUTH_HEADER_TIMESTAMP = "X-API-Wallet-Timestamp";
export const AUTH_HEADER_NONCE = "X-API-Wallet-Nonce";

/** Accept a 64-hex-char string or 32 raw bytes. */
export function toKeyBytes(key: HexOrBytes, label = "key"): Uint8Array {
  const bytes = typeof key === "string" ? hexToBytes(key.trim().replace(/^0x/i, "")) : key;
  if (bytes.length !== 32)
    throw new RangeError(`${label} must be 32 bytes (64 hex chars), got ${bytes.length}`);
  return bytes;
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === "string" ? utf8ToBytes(input) : input));
}

export function derivePublicKeyHex(privateKey: HexOrBytes): string {
  return bytesToHex(ed.getPublicKey(toKeyBytes(privateKey, "privateKey")));
}

/** Generate a fresh API-wallet keypair. Register `publicKeyHex` at app.strikefinance.org/api-keys. */
export function generateApiWallet(): { privateKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = ed.keygen();
  return { privateKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) };
}

export function signMessageHex(message: string, privateKey: HexOrBytes): string {
  return bytesToHex(ed.sign(utf8ToBytes(message), toKeyBytes(privateKey, "privateKey")));
}

export function verifyMessageHex(message: string, signatureHex: string, publicKey: HexOrBytes): boolean {
  try {
    return ed.verify(hexToBytes(signatureHex), utf8ToBytes(message), toKeyBytes(publicKey, "publicKey"));
  } catch {
    return false;
  }
}

export const newNonce = (): string => randomUUID();

export interface SignatureMessageInput {
  /** HTTP method; upper-cased for the message. */
  method: string;
  /** Path including query string exactly as sent, e.g. `/v2/openOrders?symbol=BTC-USD`. */
  path: string;
  /** Unix seconds. */
  timestamp: number | string;
  nonce: string;
  /** Serialised request body, or undefined/"" for none. */
  body?: string | undefined;
}

export function buildSignatureMessage(input: SignatureMessageInput): { message: string; bodyHash: string } {
  const bodyHash = sha256Hex(input.body ?? "");
  const message = `${input.method.toUpperCase()}:${input.path}:${String(input.timestamp)}:${input.nonce}:${bodyHash}`;
  return { message, bodyHash };
}

export interface SignRequestInput extends SignatureMessageInput {
  privateKey: HexOrBytes;
  /** Optional; derived from the private key when omitted. */
  publicKey?: HexOrBytes | undefined;
}

export interface SignedRequest {
  headers: AuthHeaders;
  message: string;
  bodyHash: string;
  signature: string;
  publicKey: string;
}

/**
 * Pure signing function: given a fixed key, timestamp and nonce it always produces the same output,
 * so it is unit-testable against vectors.
 */
export function signRequest(input: SignRequestInput): SignedRequest {
  const priv = toKeyBytes(input.privateKey, "privateKey");
  const publicKey = input.publicKey
    ? bytesToHex(toKeyBytes(input.publicKey, "publicKey"))
    : bytesToHex(ed.getPublicKey(priv));
  const { message, bodyHash } = buildSignatureMessage(input);
  const signature = bytesToHex(ed.sign(utf8ToBytes(message), priv));
  return {
    headers: {
      [AUTH_HEADER_PUBLIC_KEY]: publicKey,
      [AUTH_HEADER_SIGNATURE]: signature,
      [AUTH_HEADER_TIMESTAMP]: String(input.timestamp),
      [AUTH_HEADER_NONCE]: input.nonce,
    },
    message,
    bodyHash,
    signature,
    publicKey,
  };
}

/** Server-side check, used in tests to prove the headers verify against the public key. */
export function verifyRequestSignature(args: {
  headers: AuthHeaders;
  method: string;
  path: string;
  body?: string | undefined;
}): boolean {
  const { message } = buildSignatureMessage({
    method: args.method,
    path: args.path,
    timestamp: args.headers[AUTH_HEADER_TIMESTAMP],
    nonce: args.headers[AUTH_HEADER_NONCE],
    body: args.body,
  });
  return verifyMessageHex(message, args.headers[AUTH_HEADER_SIGNATURE], args.headers[AUTH_HEADER_PUBLIC_KEY]);
}

/**
 * Payload format for the user-stream `session.logon`.
 * - `session.logon`: `session.logon:${timestamp_ms}:${apiKey}` (official user WebSocket docs; default)
 * - `apiKey-query`: `apiKey=${apiKey}&timestamp=${timestamp_ms}` (vendored strike-userstream skill)
 */
export type LogonMessageFormat = "session.logon" | "apiKey-query";

export function buildLogonMessage(
  apiKey: string,
  timestampMs: number,
  format: LogonMessageFormat = "session.logon",
): string {
  return format === "apiKey-query"
    ? `apiKey=${apiKey}&timestamp=${timestampMs}`
    : `session.logon:${timestampMs}:${apiKey}`;
}

export interface LogonMessage {
  method: "session.logon";
  params: { apiKey: string; signature: string; timestamp: number };
  id: number | string;
}

export interface UserStreamLogonInput {
  privateKey: HexOrBytes;
  /** Public key hex; derived from the private key when omitted. */
  apiKey?: string | undefined;
  /** Unix milliseconds. */
  timestampMs: number;
  id?: number | string | undefined;
  format?: LogonMessageFormat | undefined;
}

/** Build the signed `session.logon` frame for the user WebSocket. Pure given a fixed timestamp. */
export function userStreamLogon(input: UserStreamLogonInput): {
  message: LogonMessage;
  signedPayload: string;
} {
  const apiKey = input.apiKey ?? derivePublicKeyHex(input.privateKey);
  const signedPayload = buildLogonMessage(apiKey, input.timestampMs, input.format);
  const signature = signMessageHex(signedPayload, input.privateKey);
  return {
    message: {
      method: "session.logon",
      params: { apiKey, signature, timestamp: input.timestampMs },
      id: input.id ?? 1,
    },
    signedPayload,
  };
}

export function verifyLogonSignature(
  message: LogonMessage,
  format: LogonMessageFormat = "session.logon",
): boolean {
  const payload = buildLogonMessage(message.params.apiKey, message.params.timestamp, format);
  return verifyMessageHex(payload, message.params.signature, message.params.apiKey);
}
