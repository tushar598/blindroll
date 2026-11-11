import { describe, expect, it } from "vitest";
import { hashMessage, recoverMessageAddress, verifyMessage } from "viem";
import { type PayoutKind, ValidationError, buildClaimMessage, buildViewMessage, eip191HashHex } from "../src/index.ts";
import vectors from "../test-vectors/claim-message.json" with { type: "json" };
import merkle from "../test-vectors/merkle.json" with { type: "json" };

type Fields = {
  contract_id: string;
  run_key: string;
  leaf_hash: string;
  payout_kind: string;
  payout_target: string;
  destination_asset: string;
  destination_address: string;
  expires_at_ms: string;
};

const build = (c: Fields) =>
  buildClaimMessage({
    contractId: c.contract_id,
    runKey: c.run_key,
    leafHashHex: c.leaf_hash,
    payoutKind: c.payout_kind as PayoutKind,
    payoutTarget: c.payout_target,
    destinationAsset: c.destination_asset,
    destinationAddress: c.destination_address,
    expiresAtMs: BigInt(c.expires_at_ms),
  });

describe("claim message", () => {
  it("matches the documented format exactly", () => {
    const msg = buildClaimMessage({
      contractId: "blindroll.testnet",
      runKey: "run-1",
      leafHashHex: "ab".repeat(32),
      payoutKind: "oneclick",
      payoutTarget: "deposit.testnet",
      destinationAsset: "nep141:usdc.near",
      destinationAddress: "0x8ba1f109551bd432803012645ac136ddd64dba72",
      expiresAtMs: 1794355200000n,
    });
    expect(msg).toBe(
      "Blindroll claim v1\n" +
        "contract: blindroll.testnet\n" +
        "run: run-1\n" +
        `leaf: ${"ab".repeat(32)}\n` +
        "payout: oneclick:deposit.testnet\n" +
        "to: nep141:usdc.near:0x8ba1f109551bd432803012645ac136ddd64dba72\n" +
        "expires: 1794355200000",
    );
    expect(msg.endsWith("\n")).toBe(false);
  });

  for (const c of vectors.cases) {
    it(`vector "${c.name}": message, EIP-191 hash, signature`, async () => {
      const message = build(c);
      expect(message).toBe(c.message);
      expect(eip191HashHex(message)).toBe(c.eip191_hash);
      // Independent check against viem's EIP-191 implementation.
      expect(hashMessage(message)).toBe(`0x${c.eip191_hash}`);
      const sig = c.signature as `0x${string}`;
      expect((await recoverMessageAddress({ message, signature: sig })).toLowerCase()).toBe(c.signer_address);
      expect(await verifyMessage({ address: c.signer_address as `0x${string}`, message, signature: sig })).toBe(true);
      const wrong = await recoverMessageAddress({ message, signature: c.wrong_signer_signature as `0x${string}` });
      expect(wrong.toLowerCase()).not.toBe(c.signer_address);
    });

    it(`vector "${c.name}": leaf belongs to the signer in the referenced tree`, () => {
      const t = merkle.trees.find((x) => x.name === c.tree)!;
      expect(t.leaf_hashes[c.leaf_index]).toBe(c.leaf_hash);
      expect(t.leaves[c.leaf_index]!.address).toBe(c.signer_address);
      expect(t.run_key).toBe(c.run_key);
    });
  }

  for (const bad of vectors.invalid_messages) {
    it(`rejects: ${bad.reason}`, () => {
      expect(() => build(bad)).toThrow(ValidationError);
    });
  }

  it("rejects bad expiry values", () => {
    const ok = vectors.cases[0]!;
    expect(() => build({ ...ok, expires_at_ms: "0" })).toThrow(ValidationError);
    expect(() => build({ ...ok, expires_at_ms: (1n << 64n).toString() })).toThrow(ValidationError);
  });
});

describe("view message", () => {
  it("matches the documented format", () => {
    expect(
      buildViewMessage({ runKey: "run-1", address: "hiro.testnet", nonce: "abc123", issued: "2026-11-10T12:00:00.000Z" }),
    ).toBe("Blindroll: view my payout\nrun: run-1\naddress: hiro.testnet\nnonce: abc123\nissued: 2026-11-10T12:00:00.000Z");
  });
  it("rejects injected newlines", () => {
    expect(() => buildViewMessage({ runKey: "run-1", address: "a\nb", nonce: "n", issued: "t" })).toThrow(ValidationError);
    expect(() => buildViewMessage({ runKey: "run\n1", address: "a", nonce: "n", issued: "t" })).toThrow(ValidationError);
  });
});
