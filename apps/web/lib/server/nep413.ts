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

/** `ed25519:<base58>` → 32 raw bytes, or null. */
export function parseEd25519PublicKey(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith("ed25519:")) return null;
  const raw = base58Decode(publicKey.slice("ed25519:".length));
  return raw && raw.length === 32 ? raw : null;
}

/** Verifies a wallet's NEP-413 signature (base64) over sha256(borsh(payload)). */
export function verifyNep413Signature(input: {
  publicKey: string;
  signatureBase64: string;
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}): boolean {
  const pk = parseEd25519PublicKey(input.publicKey);
  if (!pk) return false;
  let sig: Uint8Array;
  try {
    sig = new Uint8Array(Buffer.from(input.signatureBase64, "base64"));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, sha256(serializeNep413(input)), pk);
  } catch {
    return false;
  }
}
