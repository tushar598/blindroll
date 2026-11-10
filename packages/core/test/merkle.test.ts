import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Chain,
  type Leaf,
  ValidationError,
  buildTree,
  buildTreeFromLeaves,
  computeRoot,
  getProof,
  hashPair,
  leafHash,
  leafHashHex,
  leafPreimage,
  parseAmount,
  verifyProof,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hash.js";
import vectors from "../test-vectors/merkle.json" with { type: "json" };

/** Independent sha256 (node:crypto, not @noble) so the vectors are not self-referential. */
const nodeSha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

function toLeaf(j: { chain: string; address: string; amount: string; salt_hex: string }): Leaf {
  return { chain: j.chain as Chain, address: j.address, amount: parseAmount(j.amount), saltHex: j.salt_hex };
}

/** Independent reference: plain recursive tree over Buffers. */
function referenceRoot(hashes: Buffer[]): Buffer {
  if (hashes.length === 1) return hashes[0]!;
  const next: Buffer[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    const a = hashes[i]!;
    const b = hashes[i + 1];
    if (!b) next.push(a);
    else next.push(nodeSha256(Buffer.compare(a, b) <= 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a])));
  }
  return referenceRoot(next);
}

describe("leaf format", () => {
  it("matches the documented preimage exactly", () => {
    const leaf: Leaf = { chain: "evm", address: "0x8ba1f109551bd432803012645ac136ddd64dba72", amount: 1_000_000_000n, saltHex: "00112233445566778899aabbccddeeff" };
    const pre = leafPreimage("run-1", leaf);
    expect(pre).toBe("blindroll:leaf:v1|run-1|evm|0x8ba1f109551bd432803012645ac136ddd64dba72|1000000000|00112233445566778899aabbccddeeff");
    expect(leafHashHex("run-1", leaf)).toBe(nodeSha256(pre).toString("hex"));
  });

  for (const t of vectors.trees) {
    it(`vector tree "${t.name}": preimages and leaf hashes`, () => {
      t.leaves.forEach((j, i) => {
        const leaf = toLeaf(j);
        expect(leafPreimage(t.run_key, leaf)).toBe(t.preimages[i]);
        expect(leafHashHex(t.run_key, leaf)).toBe(t.leaf_hashes[i]);
        expect(nodeSha256(t.preimages[i]!).toString("hex")).toBe(t.leaf_hashes[i]);
      });
    });
  }

  for (const bad of vectors.invalid_leaves) {
    it(`rejects: ${bad.reason}`, () => {
      expect(() => {
        const amount = parseAmount(bad.amount);
        leafHash(bad.run_key, { chain: bad.chain as Chain, address: bad.address, amount, saltHex: bad.salt_hex });
      }).toThrow(ValidationError);
    });
  }

  it("rejects non-bigint and out-of-range amounts", () => {
    const base = { chain: "near" as const, address: "a.testnet", saltHex: "00112233445566778899aabbccddeeff" };
    expect(() => leafHash("r", { ...base, amount: 0n })).toThrow(ValidationError);
    expect(() => leafHash("r", { ...base, amount: -1n })).toThrow(ValidationError);
    expect(() => leafHash("r", { ...base, amount: 1n << 128n })).toThrow(ValidationError);
    expect(() => leafHash("r", { ...base, amount: 1.5 as unknown as bigint })).toThrow(ValidationError);
  });
});

describe("merkle tree", () => {
  for (const t of vectors.trees) {
    it(`vector tree "${t.name}": root, proofs, total`, () => {
      const leaves = t.leaves.map(toLeaf);
      const tree = buildTreeFromLeaves(t.run_key, leaves);
      expect(tree.rootHex).toBe(t.root);
      expect(referenceRoot(t.leaf_hashes.map((h) => Buffer.from(h, "hex"))).toString("hex")).toBe(t.root);
      expect(leaves.reduce((s, l) => s + l.amount, 0n).toString()).toBe(t.total_amount);
      leaves.forEach((_, i) => {
        const proof = getProof(tree, i);
        expect(proof).toEqual(t.proofs[i]);
        expect(verifyProof(hexToBytes(t.leaf_hashes[i]!), proof, t.root)).toBe(true);
      });
    });
  }

  it("single-leaf tree: root = leaf hash, proof = []", () => {
    const t = vectors.trees.find((x) => x.name === "single")!;
    expect(t.root).toBe(t.leaf_hashes[0]);
    expect(t.proofs[0]).toEqual([]);
  });

  it("sample run matches docs/samples/README.md", () => {
    const t = vectors.trees.find((x) => x.name === "sample-run")!;
    expect(t.leaves.length).toBe(6);
    expect(t.total_amount).toBe("14600500000");
  });

  it("odd node is promoted unchanged", () => {
    const t = vectors.trees.find((x) => x.name === "three-odd-promotion")!;
    const [a, b, c] = t.leaf_hashes.map(hexToBytes) as [Uint8Array, Uint8Array, Uint8Array];
    expect(bytesToHex(hashPair(hashPair(a, b), c))).toBe(t.root);
    expect(t.proofs[2]!.length).toBe(1);
  });

  it("hashPair is order-independent", () => {
    const a = nodeSha256("a");
    const b = nodeSha256("b");
    expect(bytesToHex(hashPair(a, b))).toBe(bytesToHex(hashPair(b, a)));
  });

  for (const bad of vectors.invalid_proofs) {
    it(`rejects proof: ${bad.reason}`, () => {
      const t = vectors.trees.find((x) => x.name === bad.tree)!;
      expect(verifyProof(hexToBytes(t.leaf_hashes[bad.leaf_index]!), bad.proof, t.root)).toBe(false);
    });
  }

  it("rejects empty trees, duplicate leaves, bad indexes, oversized proofs", () => {
    const h = nodeSha256("x");
    expect(() => buildTree([])).toThrow(ValidationError);
    expect(() => buildTree([h, h])).toThrow(ValidationError);
    expect(() => buildTree([h.subarray(0, 31)])).toThrow(ValidationError);
    const tree = buildTree([h, nodeSha256("y")]);
    expect(() => getProof(tree, 2)).toThrow(ValidationError);
    expect(() => getProof(tree, -1)).toThrow(ValidationError);
    expect(() => computeRoot(h, Array(33).fill("ab".repeat(32)))).toThrow(ValidationError);
  });

  it("handles a 1000-leaf tree", () => {
    const hashes = Array.from({ length: 1000 }, (_, i) => nodeSha256(`leaf-${i}`));
    const tree = buildTree(hashes);
    expect(tree.rootHex).toBe(referenceRoot(hashes).toString("hex"));
    for (const i of [0, 1, 499, 998, 999]) {
      expect(verifyProof(hashes[i]!, getProof(tree, i), tree.rootHex)).toBe(true);
    }
  });
});
