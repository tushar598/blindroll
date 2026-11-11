import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, sha256 } from "@blindroll/core";

/**
 * Minimal NEAR transaction builder for the relayer: one FunctionCall action, signed with an
 * ed25519 key. Borsh layout per the NEAR protocol spec (Transaction / SignedTransaction).
 * Kept dependency-free on purpose: the relayer sends exactly one kind of transaction.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function uintLe(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error("integer out of range");
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
const u32 = (n: number) => uintLe(BigInt(n), 4);
function str(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concat([u32(b.length), b]);
}

export interface RelayerKey {
  /** `ed25519:<base58>` */
  publicKey: string;
  publicKeyBytes: Uint8Array;
  seed: Uint8Array;
}

/** Parses `ed25519:<base58 of seed(32) || public key(32)>` (the NEAR CLI format) or a bare 32-byte seed. */
export function parseRelayerKey(privateKey: string): RelayerKey {
  if (!privateKey.startsWith("ed25519:")) throw new Error("RELAYER_PRIVATE_KEY must start with ed25519:");
  const raw = base58Decode(privateKey.slice("ed25519:".length));
  if (!raw || (raw.length !== 64 && raw.length !== 32)) throw new Error("RELAYER_PRIVATE_KEY has the wrong length");
  const seed = raw.slice(0, 32);
  const publicKeyBytes = ed25519.getPublicKey(seed);
  if (raw.length === 64 && !raw.slice(32).every((b, i) => b === publicKeyBytes[i])) {
    throw new Error("RELAYER_PRIVATE_KEY is inconsistent (public half does not match)");
  }
  return { publicKey: `ed25519:${base58Encode(publicKeyBytes)}`, publicKeyBytes, seed };
}

export interface FunctionCallTx {
  signerId: string;
  receiverId: string;
  /** Access-key nonce to use (current nonce + 1). */
  nonce: bigint;
  /** A recent block hash, base58. */
  blockHash: string;
  methodName: string;
  args: object;
  gas: bigint;
  deposit: bigint;
}

export function serializeTransaction(tx: FunctionCallTx, publicKeyBytes: Uint8Array): Uint8Array {
  const blockHash = base58Decode(tx.blockHash);
  if (!blockHash || blockHash.length !== 32) throw new Error("block hash must be 32 bytes");
  const args = new TextEncoder().encode(JSON.stringify(tx.args));
  return concat([
    str(tx.signerId),
    new Uint8Array([0]), // key type: ed25519
    publicKeyBytes,
    uintLe(tx.nonce, 8),
    str(tx.receiverId),
    blockHash,
    u32(1), // one action
    new Uint8Array([2]), // Action::FunctionCall
    str(tx.methodName),
    u32(args.length),
    args,
    uintLe(tx.gas, 8),
    uintLe(tx.deposit, 16),
  ]);
}

/** Returns the signed transaction (base64, for the `send_tx` RPC) and its hash (base58). */
export function signTransaction(tx: FunctionCallTx, key: RelayerKey): { signedBase64: string; txHash: string } {
  const body = serializeTransaction(tx, key.publicKeyBytes);
  const hash = sha256(body);
  const signature = ed25519.sign(hash, key.seed);
  const signed = concat([body, new Uint8Array([0]), signature]);
  return { signedBase64: Buffer.from(signed).toString("base64"), txHash: base58Encode(hash) };
}
