import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, sha256 } from "@blindroll/core";

/** NEP-413 tag: 2^31 + 413. */
const NEP413_TAG = 2147484061;

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32le(bytes.length));
  out.set(bytes, 4);
  return out;
}

/** Borsh bytes of the NEP-413 payload { tag, message, nonce[32], recipient, callbackUrl: Option<string> }. */
export function serializeNep413(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const parts = [
    u32le(NEP413_TAG),
    borshString(p.message),
    p.nonce,
    borshString(p.recipient),
    p.callbackUrl ? new Uint8Array([1, ...borshString(p.callbackUrl)]) : new Uint8Array([0]),
  ];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

/**
 * Public key → 32 raw bytes, or null. Accepts `ed25519:<base58>` (all wallets we offer) and a bare
 * base58 key without the prefix (some wallet SDKs return it that way).
 */
export function parseEd25519PublicKey(publicKey: string): Uint8Array | null {
  const body = publicKey.startsWith("ed25519:") ? publicKey.slice("ed25519:".length) : publicKey;
  if (body.length === 0 || body.includes(":")) return null;
  const raw = base58Decode(body);
  return raw && raw.length === 32 ? raw : null;
}

/** The canonical `ed25519:<base58>` form, used for the access-key RPC check. Null when invalid. */
export function normalizeEd25519PublicKey(publicKey: string): string | null {
  if (!parseEd25519PublicKey(publicKey)) return null;
  return publicKey.startsWith("ed25519:") ? publicKey : `ed25519:${publicKey}`;
}

/**
 * Signature → 64 raw bytes, or null. NEP-413 says base64; wallets also return base64url, 128 hex
 * characters or `ed25519:<base58>`.
 */
export function decodeEd25519Signature(signature: string): Uint8Array | null {
  let raw: Uint8Array | null = null;
  if (signature.startsWith("ed25519:")) raw = base58Decode(signature.slice("ed25519:".length));
  else if (/^[0-9a-fA-F]{128}$/.test(signature)) raw = new Uint8Array(Buffer.from(signature, "hex"));
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(signature)) raw = new Uint8Array(Buffer.from(signature, "base64")); // also accepts base64url
  return raw && raw.length === 64 ? raw : null;
}

/**
 * Verifies a wallet's NEP-413 signature over sha256(borsh(payload)).
 * `callbackUrl` is part of the signed payload: a wallet that was given one (MyNearWallet) signs it,
 * so the caller passes the same value. Without it, the payload's callbackUrl is None.
 */
export function verifyNep413Signature(input: {
  publicKey: string;
  signatureBase64: string;
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}): boolean {
  const pk = parseEd25519PublicKey(input.publicKey);
  const sig = decodeEd25519Signature(input.signatureBase64);
  if (!pk || !sig) return false;
  try {
    return ed25519.verify(sig, sha256(serializeNep413(input)), pk);
  } catch {
    return false;
  }
}

/**
 * The callbackUrl a client says it gave the wallet. Only a URL on this app's own origin is used
 * (anything else is ignored, so the signature must then verify without one).
 */
export function acceptedCallbackUrl(callbackUrl: unknown, appUrl: string): string | undefined {
  if (typeof callbackUrl !== "string" || callbackUrl.length > 2048) return undefined;
  try {
    return new URL(callbackUrl).origin === new URL(appUrl).origin ? callbackUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Tries the payload without a callbackUrl first (most wallets), then with the accepted one. */
export function verifyNep413Any(input: Omit<Parameters<typeof verifyNep413Signature>[0], "callbackUrl"> & { callbackUrl?: string }): boolean {
  const { callbackUrl, ...rest } = input;
  return verifyNep413Signature(rest) || (callbackUrl !== undefined && verifyNep413Signature({ ...rest, callbackUrl }));
}
