import { describe, expect, it } from "vitest";
import {
  AUTH_HEADER_NONCE,
  AUTH_HEADER_PUBLIC_KEY,
  AUTH_HEADER_SIGNATURE,
  AUTH_HEADER_TIMESTAMP,
  buildLogonMessage,
  buildSignatureMessage,
  derivePublicKeyHex,
  generateApiWallet,
  sha256Hex,
  signRequest,
  userStreamLogon,
  verifyLogonSignature,
  verifyMessageHex,
  verifyRequestSignature,
} from "./auth.js";

// RFC 8032 test vector 1.
const SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const NONCE = "550e8400-e29b-41d4-a716-446655440000";
const TS = 1_700_000_000;

describe("key handling", () => {
  it("derives the RFC 8032 public key from the private key", () => {
    expect(derivePublicKeyHex(SK)).toBe(PK);
  });

  it("generates a valid 32-byte keypair", () => {
    const w = generateApiWallet();
    expect(w.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(w.publicKeyHex).toBe(derivePublicKeyHex(w.privateKeyHex));
  });

  it("rejects keys of the wrong length", () => {
    expect(() => derivePublicKeyHex("abcd")).toThrow(/32 bytes/);
  });
});

describe("signature message", () => {
  it("hashes the empty body for GETs", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const { message, bodyHash } = buildSignatureMessage({
      method: "get",
      path: "/v2/openOrders?symbol=BTC-USD",
      timestamp: TS,
      nonce: NONCE,
    });
    expect(bodyHash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(message).toBe(
      `GET:/v2/openOrders?symbol=BTC-USD:${TS}:${NONCE}:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    );
  });

  it("hashes the exact body bytes for POSTs", () => {
    const body = '{"symbol":"BTC-USD","side":"buy","type":"limit","size":"0.01000","price":"78000.0"}';
    const { message, bodyHash } = buildSignatureMessage({
      method: "POST",
      path: "/v2/order",
      timestamp: TS,
      nonce: NONCE,
      body,
    });
    expect(bodyHash).toBe(sha256Hex(body));
    expect(message).toBe(`POST:/v2/order:${TS}:${NONCE}:${sha256Hex(body)}`);
    // A different serialisation of the same JSON changes the hash.
    expect(sha256Hex('{"symbol": "BTC-USD"}')).not.toBe(sha256Hex('{"symbol":"BTC-USD"}'));
  });
});

describe("signRequest", () => {
  it("is deterministic for fixed key, timestamp and nonce and verifies against the public key", () => {
    const a = signRequest({
      method: "GET",
      path: "/v2/account",
      timestamp: TS,
      nonce: NONCE,
      privateKey: SK,
    });
    const b = signRequest({
      method: "GET",
      path: "/v2/account",
      timestamp: TS,
      nonce: NONCE,
      privateKey: SK,
    });
    expect(a).toEqual(b);
    expect(a.headers[AUTH_HEADER_PUBLIC_KEY]).toBe(PK);
    expect(a.headers[AUTH_HEADER_SIGNATURE]).toMatch(/^[0-9a-f]{128}$/);
    expect(a.headers[AUTH_HEADER_TIMESTAMP]).toBe(String(TS));
    expect(a.headers[AUTH_HEADER_NONCE]).toBe(NONCE);
    expect(verifyMessageHex(a.message, a.signature, PK)).toBe(true);
    expect(verifyRequestSignature({ headers: a.headers, method: "GET", path: "/v2/account" })).toBe(true);
  });

  it("matches a pinned vector", () => {
    const s = signRequest({
      method: "GET",
      path: "/v2/account",
      timestamp: TS,
      nonce: NONCE,
      privateKey: SK,
    });
    expect(s.signature).toBe(
      "2eeeaa2d500ad0e3efb92f8ba73902d668a78d1af9c34a730a9e8a80a8221a4ee0097fb3dd14239eaaef0189a909bf5981b97e15ff11b11fe431b847349ff700",
    );
  });

  it("fails verification when method, path, body, timestamp or nonce are tampered", () => {
    const body = '{"order_id":123456,"symbol":"BTC-USD"}';
    const s = signRequest({
      method: "DELETE",
      path: "/v2/order/cancel",
      timestamp: TS,
      nonce: NONCE,
      privateKey: SK,
      body,
    });
    expect(
      verifyRequestSignature({ headers: s.headers, method: "DELETE", path: "/v2/order/cancel", body }),
    ).toBe(true);
    expect(
      verifyRequestSignature({ headers: s.headers, method: "POST", path: "/v2/order/cancel", body }),
    ).toBe(false);
    expect(
      verifyRequestSignature({ headers: s.headers, method: "DELETE", path: "/v2/order/cancel?x=1", body }),
    ).toBe(false);
    expect(
      verifyRequestSignature({
        headers: s.headers,
        method: "DELETE",
        path: "/v2/order/cancel",
        body: body + " ",
      }),
    ).toBe(false);
    expect(
      verifyRequestSignature({
        headers: { ...s.headers, [AUTH_HEADER_TIMESTAMP]: String(TS + 1) },
        method: "DELETE",
        path: "/v2/order/cancel",
        body,
      }),
    ).toBe(false);
    expect(
      verifyRequestSignature({
        headers: { ...s.headers, [AUTH_HEADER_NONCE]: "00000000-0000-4000-8000-000000000000" },
        method: "DELETE",
        path: "/v2/order/cancel",
        body,
      }),
    ).toBe(false);
  });

  it("accepts an explicit public key and raw byte keys", () => {
    const s = signRequest({
      method: "GET",
      path: "/v2/positions",
      timestamp: TS,
      nonce: NONCE,
      privateKey: Buffer.from(SK, "hex"),
      publicKey: PK,
    });
    expect(s.publicKey).toBe(PK);
    expect(verifyRequestSignature({ headers: s.headers, method: "GET", path: "/v2/positions" })).toBe(true);
  });
});

describe("user stream logon", () => {
  it("signs session.logon:${timestamp_ms}:${apiKey} by default", () => {
    const ts = 1_705_000_000_000;
    const { message, signedPayload } = userStreamLogon({ privateKey: SK, timestampMs: ts, id: 7 });
    expect(signedPayload).toBe(`session.logon:${ts}:${PK}`);
    expect(message).toEqual({
      method: "session.logon",
      params: { apiKey: PK, signature: expect.stringMatching(/^[0-9a-f]{128}$/), timestamp: ts },
      id: 7,
    });
    expect(verifyLogonSignature(message)).toBe(true);
    expect(verifyLogonSignature(message, "apiKey-query")).toBe(false);
  });

  it("supports the apiKey=...&timestamp=... payload documented in the skill", () => {
    const ts = 1_705_000_000_000;
    expect(buildLogonMessage(PK, ts, "apiKey-query")).toBe(`apiKey=${PK}&timestamp=${ts}`);
    const { message } = userStreamLogon({ privateKey: SK, timestampMs: ts, format: "apiKey-query" });
    expect(verifyLogonSignature(message, "apiKey-query")).toBe(true);
    expect(verifyLogonSignature(message, "session.logon")).toBe(false);
  });
});
