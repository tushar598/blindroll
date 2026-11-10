import { bytesToHex, keccak256, utf8ToBytes } from "../hash.js";
import type { Chain } from "../merkle/leaf.js";
import { isNearAccountId } from "../validate.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 (Bitcoin alphabet). Returns null on an invalid character. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const d = BASE58.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** EIP-55 checksum form of a lowercase 40-hex address body. */
export function toChecksumAddress(lowerHex40: string): string {
  const hash = bytesToHex(keccak256(utf8ToBytes(lowerHex40)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = lowerHex40[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * Returns the EVM address in leaf format (lowercase) or null if invalid.
 * All-lowercase and all-uppercase hex are accepted; mixed case must pass the EIP-55 checksum.
 */
export function normalizeEvmAddress(raw: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  const body = raw.slice(2);
  const lower = body.toLowerCase();
  if (body !== lower && body !== body.toUpperCase() && toChecksumAddress(lower) !== raw) return null;
  return `0x${lower}`;
}

export function isSolanaAddress(raw: string): boolean {
  return raw.length >= 32 && raw.length <= 44 && base58Decode(raw)?.length === 32;
}

/** Chain guess from the address text alone (docs/05, Step 2). */
export function inferChain(raw: string): Chain | null {
  if (raw.startsWith("0x") || raw.startsWith("0X")) return "evm";
  if (/\.(near|testnet)$/.test(raw) || /^[0-9a-f]{64}$/.test(raw)) return "near";
  if (isSolanaAddress(raw)) return "solana";
  return null;
}

/** Address in leaf format for the chain, or null if it is not valid there. */
export function normalizeAddress(chain: Chain, raw: string): string | null {
  if (chain === "evm") return normalizeEvmAddress(raw);
  if (chain === "near") return isNearAccountId(raw) ? raw : null;
  return isSolanaAddress(raw) ? raw : null;
}
