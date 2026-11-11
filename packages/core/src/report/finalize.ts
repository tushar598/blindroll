import canonicalize from "canonicalize";
import { bytesToHex, compareBytes, hexToBytes, sha256, utf8ToBytes } from "../hash.ts";
import { type Chain, type Leaf, leafHash } from "../merkle/leaf.ts";
import { buildTree, getProof } from "../merkle/tree.ts";
import { SALT_HEX_RE, ValidationError, amountToString, assertRunKey } from "../validate.ts";
import type { Review } from "./review.ts";

/** RFC 8785 canonical JSON. Report and table hashes are sha256 over these bytes. */
export function canonicalJson(value: unknown): string {
  const s = canonicalize(value);
  if (s === undefined) throw new ValidationError("value cannot be canonicalized");
  return s;
}

export function sha256HexOfJson(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

/** 16 random bytes as 32 lowercase hex chars (Web Crypto; works in Node and the browser). */
export function randomSaltHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export interface FinalRow {
  rowNumber: number;
  leaf: Leaf;
  leafHashHex: string;
  /** sha256 of the leaf hash bytes: lets approvers match report findings to rows without publishing leaves. */
  rowHashHex: string;
  proof: string[];
}

export interface FinalizedRun {
  runKey: string;
  /** Sorted by leaf hash (the tree's leaf order). */
  rows: FinalRow[];
  merkleRoot: string;
  tableSha256: string;
  totalAmount: bigint;
  recipientCount: number;
}

export function rowHashHex(leafHashHex: string): string {
  return bytesToHex(sha256(hexToBytes(leafHashHex)));
}

/**
 * Locks a reviewed table into leaves, a Merkle root and per-row proofs.
 * Refuses unless the review has no errors and every warning is overridden.
 * `salts` maps rowNumber → salt_hex; the caller generates them once (randomSaltHex) and stores them.
 * Leaves are ordered by leaf hash, so the tree does not reveal the file's row order.
 */
export function finalizeRun(input: { runKey: string; review: Review; salts: ReadonlyMap<number, string> }): FinalizedRun {
  assertRunKey(input.runKey);
  const { review } = input;
  if (review.errorCount > 0) throw new ValidationError(`Cannot finalize: ${review.errorCount} error(s) must be fixed first`);
  if (review.openWarningCount > 0) throw new ValidationError(`Cannot finalize: ${review.openWarningCount} warning(s) need an override reason`);
  if (review.rows.length === 0) throw new ValidationError("Cannot finalize: the run has no rows");

  const rows = review.rows.map((r) => {
    if (r.chain === null || r.address === null || r.amount === null || !r.currencyOk) {
      throw new ValidationError(`Cannot finalize: row ${r.rowNumber} is not valid`); // unreachable when errorCount is 0
    }
    const saltHex = input.salts.get(r.rowNumber);
    if (saltHex === undefined || !SALT_HEX_RE.test(saltHex)) throw new ValidationError(`Row ${r.rowNumber} has no valid salt`);
    const leaf: Leaf = { chain: r.chain as Chain, address: r.address, amount: r.amount, saltHex };
    return { rowNumber: r.rowNumber, leaf, hash: leafHash(input.runKey, leaf) };
  });
  rows.sort((a, b) => compareBytes(a.hash, b.hash));
  const tree = buildTree(rows.map((r) => r.hash));

  const finalRows: FinalRow[] = rows.map((r, i) => {
    const leafHashHex = bytesToHex(r.hash);
    return { rowNumber: r.rowNumber, leaf: r.leaf, leafHashHex, rowHashHex: rowHashHex(leafHashHex), proof: getProof(tree, i) };
  });
  return {
    runKey: input.runKey,
    rows: finalRows,
    merkleRoot: tree.rootHex,
    // docs/05: canonical JSON array of {chain, address, amount}, sorted by leaf hash.
    tableSha256: sha256HexOfJson(rows.map((r) => ({ chain: r.leaf.chain, address: r.leaf.address, amount: amountToString(r.leaf.amount) }))),
    totalAmount: rows.reduce((s, r) => s + r.leaf.amount, 0n),
    recipientCount: rows.length,
  };
}
