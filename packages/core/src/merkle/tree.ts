import { bytesToHex, compareBytes, concatBytes, hexToBytes, sha256 } from "../hash.js";
import { HASH_HEX_RE, ValidationError } from "../validate.js";
import { type Leaf, leafHash } from "./leaf.js";

/** Proofs longer than this are rejected (the contract applies the same cap). */
export const MAX_PROOF_LEN = 32;

/** Internal node = sha256(min(a, b) || max(a, b)), byte-wise comparison. */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compareBytes(a, b) <= 0 ? sha256(concatBytes(a, b)) : sha256(concatBytes(b, a));
}

export interface MerkleTree {
  /** levels[0] = leaf hashes in input order; last level = [root]. */
  levels: Uint8Array[][];
  root: Uint8Array;
  rootHex: string;
}

/**
 * Builds the tree from leaf hashes in the given order.
 * Pairs are (0,1), (2,3), …; an odd node at a level is promoted unchanged.
 * A single-leaf tree has root = leaf hash.
 */
export function buildTree(leafHashes: Uint8Array[]): MerkleTree {
  if (leafHashes.length === 0) throw new ValidationError("cannot build a tree with no leaves");
  const seen = new Set<string>();
  for (const h of leafHashes) {
    if (h.length !== 32) throw new ValidationError("leaf hash must be 32 bytes");
    const hex = bytesToHex(h);
    if (seen.has(hex)) throw new ValidationError("duplicate leaf hash");
    seen.add(hex);
  }
  const levels: Uint8Array[][] = [leafHashes.slice()];
  let level = levels[0]!;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
    level = next;
  }
  const root = level[0]!;
  return { levels, root, rootHex: bytesToHex(root) };
}

export function buildTreeFromLeaves(runKey: string, leaves: Leaf[]): MerkleTree {
  return buildTree(leaves.map((l) => leafHash(runKey, l)));
}

/** Proof for the leaf at `index`: sibling hashes bottom-up, as 64-char hex strings. */
export function getProof(tree: MerkleTree, index: number): string[] {
  const leaves = tree.levels[0]!;
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new ValidationError("leaf index out of range");
  }
  const proof: string[] = [];
  let i = index;
  for (let d = 0; d < tree.levels.length - 1; d++) {
    const level = tree.levels[d]!;
    const sibling = level[i ^ 1];
    if (sibling !== undefined) proof.push(bytesToHex(sibling));
    i >>= 1;
  }
  return proof;
}

/** Recomputes the root from a leaf hash and a proof. Throws on malformed proof items. */
export function computeRoot(leaf: Uint8Array, proof: string[]): Uint8Array {
  if (leaf.length !== 32) throw new ValidationError("leaf hash must be 32 bytes");
  if (proof.length > MAX_PROOF_LEN) throw new ValidationError("proof too long");
  let node = leaf;
  for (const item of proof) {
    if (typeof item !== "string" || !HASH_HEX_RE.test(item)) {
      throw new ValidationError("proof items must be 64 lowercase hex chars");
    }
    node = hashPair(node, hexToBytes(item));
  }
  return node;
}

export function verifyProof(leaf: Uint8Array, proof: string[], rootHex: string): boolean {
  try {
    return bytesToHex(computeRoot(leaf, proof)) === rootHex;
  } catch {
    return false;
  }
}
