import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export { bytesToHex, concatBytes, hexToBytes, utf8ToBytes };

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** Byte-wise lexicographic comparison (both inputs must have equal length). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
