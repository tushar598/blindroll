/**
 * Deterministic generator for the shared test vectors (TypeScript ↔ Rust).
 * Output: test-vectors/merkle.json and test-vectors/claim-message.json.
 * Regenerate with `pnpm --filter @blindroll/core vectors`; vitest fails if the committed files drift.
 *
 * The EVM keys below are the public, well-known Hardhat/Anvil development keys #0 and #1.
 * They are test fixtures, not secrets, and must never hold real funds.
 */
import { privateKeyToAccount } from "viem/accounts";
import { buildClaimMessage, eip191HashHex, type ClaimMessageInput } from "../src/claims/message.ts";
import { bytesToHex, sha256, utf8ToBytes } from "../src/hash.ts";
import { type Leaf, leafHashHex, leafPreimage, leafToJson } from "../src/merkle/leaf.ts";
import { buildTreeFromLeaves, getProof } from "../src/merkle/tree.ts";

const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const signer0 = privateKeyToAccount(TEST_KEY_0);
const signer1 = privateKeyToAccount(TEST_KEY_1);
const ADDR_0 = signer0.address.toLowerCase();
const ADDR_1 = signer1.address.toLowerCase();

function salt(label: string): string {
  return bytesToHex(sha256(utf8ToBytes(`blindroll-test-salt:${label}`)).slice(0, 16));
}

function mk(chain: Leaf["chain"], address: string, amount: bigint, label: string): Leaf {
  return { chain, address, amount, saltHex: salt(label) };
}

interface TreeSpec {
  name: string;
  run_key: string;
  leaves: Leaf[];
}

const TREES: TreeSpec[] = [
  { name: "single", run_key: "run-single", leaves: [mk("near", "hiro.testnet", 1_050_000_000n, "single:0")] },
  {
    name: "pair",
    run_key: "run_pair",
    leaves: [
      mk("evm", "0x8ba1f109551bd432803012645ac136ddd64dba72", 1n, "pair:0"),
      mk("near", "ben-okafor.testnet", 800_000_000n, "pair:1"),
    ],
  },
  {
    name: "three-odd-promotion",
    run_key: "RUN-3",
    leaves: [
      mk("evm", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", 950_000_000n, "three:0"),
      mk("solana", "4Nd1mYQzvgV8Vr3Z3nYb7pD6T5K4kTq9s1yX2wP3hRzE", 123_456_789n, "three:1"),
      mk("near", "a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1", 340282366920938463463374607431768211455n, "three:2"),
    ],
  },
  {
    name: "five",
    run_key: "0f8fad5b-d9cb-469f-a165-70867728950e",
    leaves: [0, 1, 2, 3, 4].map((i) => mk("near", `user${i}.testnet`, BigInt(1_000_000 * (i + 1)), `five:${i}`)),
  },
  {
    // The clean table expected from docs/samples/payroll-messy.csv (see docs/samples/README.md).
    name: "sample-run",
    run_key: "demo-run-2026-10",
    leaves: [
      mk("evm", "0x8ba1f109551bd432803012645ac136ddd64dba72", 1_200_500_000n, "sample:asha"),
      mk("near", "ben-okafor.testnet", 800_000_000n, "sample:ben"),
      mk("evm", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", 950_000_000n, "sample:chen"),
      mk("evm", "0x2546bcd3c84621e976d8185a91a922ae77ecec30", 1_100_000_000n, "sample:dana"),
      mk("evm", "0xbda5747bfd65f08deb54cb465eb87d40e51b197e", 9_500_000_000n, "sample:elif"),
      mk("near", "hiro.testnet", 1_050_000_000n, "sample:hiro"),
    ],
  },
  {
    // Used by the contract's unit and sandbox claim tests: EVM leaves belong to the public test
    // keys #0 and #1; NEAR leaves are *.test.near so the accounts can exist in the local sandbox.
    name: "claim-demo",
    run_key: "claim-demo-1",
    leaves: [
      mk("evm", ADDR_0, 1_200_500_000n, "claim:0"),
      mk("near", "ben.test.near", 800_000_000n, "claim:1"),
      mk("evm", ADDR_1, 950_000_000n, "claim:2"),
      mk("near", "hiro.test.near", 1_050_000_000n, "claim:3"),
      mk("evm", "0x2546bcd3c84621e976d8185a91a922ae77ecec30", 1_100_000_000n, "claim:4"),
    ],
  },
];

function treeVector(spec: TreeSpec) {
  const tree = buildTreeFromLeaves(spec.run_key, spec.leaves);
  return {
    name: spec.name,
    run_key: spec.run_key,
    leaves: spec.leaves.map(leafToJson),
    preimages: spec.leaves.map((l) => leafPreimage(spec.run_key, l)),
    leaf_hashes: spec.leaves.map((l) => leafHashHex(spec.run_key, l)),
    total_amount: spec.leaves.reduce((s, l) => s + l.amount, 0n).toString(),
    root: tree.rootHex,
    proofs: spec.leaves.map((_, i) => getProof(tree, i)),
  };
}

const S = "00112233445566778899aabbccddeeff";
/** Inputs both implementations must reject (raw strings; `amount` is a string as at the API boundary). */
const INVALID_LEAVES = [
  { reason: "run_key contains |", run_key: "run|1", chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "run_key contains newline", run_key: "run\n1", chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "run_key contains carriage return", run_key: "run\r1", chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "run_key empty", run_key: "", chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "run_key longer than 64", run_key: "r".repeat(65), chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "run_key contains space", run_key: "run 1", chain: "near", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "unknown chain", run_key: "run-1", chain: "btc", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "chain contains |", run_key: "run-1", chain: "near|evm", address: "a.testnet", amount: "1", salt_hex: S },
  { reason: "near address contains |", run_key: "run-1", chain: "near", address: "a|b.testnet", amount: "1", salt_hex: S },
  { reason: "near address contains newline", run_key: "run-1", chain: "near", address: "a\nb.testnet", amount: "1", salt_hex: S },
  { reason: "near address uppercase", run_key: "run-1", chain: "near", address: "Alice.testnet", amount: "1", salt_hex: S },
  { reason: "near address too short", run_key: "run-1", chain: "near", address: "a", amount: "1", salt_hex: S },
  { reason: "evm address checksummed (must be lowercase)", run_key: "run-1", chain: "evm", address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", amount: "1", salt_hex: S },
  { reason: "evm address too short", run_key: "run-1", chain: "evm", address: "0x123", amount: "1", salt_hex: S },
  { reason: "evm address without 0x", run_key: "run-1", chain: "evm", address: "8ba1f109551bd432803012645ac136ddd64dba72", amount: "1", salt_hex: S },
  { reason: "evm address with trailing |", run_key: "run-1", chain: "evm", address: "0x8ba1f109551bd432803012645ac136ddd64dba7|", amount: "1", salt_hex: S },
  { reason: "solana address with invalid base58 char", run_key: "run-1", chain: "solana", address: "0Nd1mYQzvgV8Vr3Z3nYb7pD6T5K4kTq9s1yX2wP3hRzE", amount: "1", salt_hex: S },
  { reason: "amount zero", run_key: "run-1", chain: "near", address: "a.testnet", amount: "0", salt_hex: S },
  { reason: "amount leading zero", run_key: "run-1", chain: "near", address: "a.testnet", amount: "0100", salt_hex: S },
  { reason: "amount negative", run_key: "run-1", chain: "near", address: "a.testnet", amount: "-5", salt_hex: S },
  { reason: "amount with plus sign", run_key: "run-1", chain: "near", address: "a.testnet", amount: "+5", salt_hex: S },
  { reason: "amount decimal", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1.5", salt_hex: S },
  { reason: "amount contains |", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1|2", salt_hex: S },
  { reason: "amount exceeds u128", run_key: "run-1", chain: "near", address: "a.testnet", amount: "340282366920938463463374607431768211456", salt_hex: S },
  { reason: "amount empty", run_key: "run-1", chain: "near", address: "a.testnet", amount: "", salt_hex: S },
  { reason: "salt too short", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1", salt_hex: "0011" },
  { reason: "salt uppercase", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1", salt_hex: S.toUpperCase() },
  { reason: "salt contains |", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1", salt_hex: "00112233445566778899aabbccddee|f" },
  { reason: "salt contains newline", run_key: "run-1", chain: "near", address: "a.testnet", amount: "1", salt_hex: "00112233445566778899aabbccddee\nf" },
];

export function generateMerkleVectors() {
  const trees = TREES.map(treeVector);
  const five = trees.find((t) => t.name === "five")!;
  const sample = trees.find((t) => t.name === "sample-run")!;
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const invalid_proofs = [
    { reason: "proof of another leaf", tree: "five", leaf_index: 0, proof: five.proofs[1]! },
    { reason: "truncated proof", tree: "five", leaf_index: 0, proof: five.proofs[0]!.slice(0, -1) },
    { reason: "tampered sibling", tree: "five", leaf_index: 2, proof: [flip(five.proofs[2]![0]!), ...five.proofs[2]!.slice(1)] },
    { reason: "extra element", tree: "five", leaf_index: 4, proof: [...five.proofs[4]!, five.leaf_hashes[0]!] },
    { reason: "empty proof for multi-leaf tree", tree: "sample-run", leaf_index: 3, proof: [] },
    { reason: "proof from a different tree", tree: "sample-run", leaf_index: 0, proof: five.proofs[0]! },
    { reason: "malformed proof item (uppercase hex)", tree: "sample-run", leaf_index: 0, proof: [sample.proofs[0]![0]!.toUpperCase(), ...sample.proofs[0]!.slice(1)] },
    { reason: "malformed proof item (short)", tree: "sample-run", leaf_index: 0, proof: ["abcd"] },
  ];
  return {
    description:
      "Shared Merkle vectors for packages/core (TypeScript) and contracts/blindroll (Rust). Generated by packages/core/scripts/gen-vectors.ts; do not edit by hand.",
    version: 1,
    leaf_format: "sha256(utf8('blindroll:leaf:v1|' + run_key + '|' + chain + '|' + address + '|' + amount + '|' + salt_hex))",
    node_format: "sha256(min(a,b) || max(a,b)); odd node promoted unchanged",
    trees,
    invalid_leaves: INVALID_LEAVES,
    invalid_proofs,
  };
}

interface ClaimSpec {
  name: string;
  tree: string;
  leaf_index: number;
  signer: typeof signer0;
  wrongSigner: typeof signer0;
  contract_id: string;
  payout_kind: "near_ft" | "oneclick";
  payout_target: string;
  destination_asset: string;
  destination_address: string;
  expires_at_ms: bigint;
}

const CLAIMS: ClaimSpec[] = [
  {
    name: "near_ft payout to a NEAR account",
    tree: "claim-demo",
    leaf_index: 0,
    signer: signer0,
    wrongSigner: signer1,
    contract_id: "blindroll.test.near",
    payout_kind: "near_ft",
    payout_target: "asha.test.near",
    destination_asset: "nep141:usdc.test.near",
    destination_address: "asha.test.near",
    expires_at_ms: 4102444800000n, // 2100-01-01: far future so sandbox tests on real clocks keep passing
  },
  {
    name: "oneclick payout to a deposit address",
    tree: "claim-demo",
    leaf_index: 2,
    signer: signer1,
    wrongSigner: signer0,
    contract_id: "blindroll.test.near",
    payout_kind: "oneclick",
    payout_target: "3ccf686b516ede32e2936c25798378623c99a5fce5bcee411d2df4b4f5fea1e0",
    destination_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destination_address: ADDR_1,
    expires_at_ms: 4102444860000n,
  },
];

const OK_MSG = {
  contract_id: "blindroll.test.near",
  run_key: "claim-demo-1",
  leaf_hash: "ab".repeat(32),
  payout_kind: "near_ft",
  payout_target: "asha.test.near",
  destination_asset: "nep141:usdc.test.near",
  destination_address: "asha.test.near",
  expires_at_ms: "1794355200000",
};
const INVALID_MESSAGES = [
  { reason: "destination_address contains newline", ...OK_MSG, destination_address: "asha.test.near\nexpires: 9999999999999" },
  { reason: "destination_address contains carriage return", ...OK_MSG, destination_address: "asha\r.test.near" },
  { reason: "destination_address contains |", ...OK_MSG, destination_address: "asha|x" },
  { reason: "destination_address empty", ...OK_MSG, destination_address: "" },
  { reason: "destination_address longer than 128", ...OK_MSG, destination_address: "a".repeat(129) },
  { reason: "destination_address non-ASCII", ...OK_MSG, destination_address: "ashа.test.near" },
  { reason: "destination_asset contains newline", ...OK_MSG, destination_asset: "nep141:usdc\n.test.near" },
  { reason: "destination_asset contains |", ...OK_MSG, destination_asset: "nep141|usdc" },
  { reason: "destination_asset empty", ...OK_MSG, destination_asset: "" },
  { reason: "run_key contains newline", ...OK_MSG, run_key: "claim\ndemo" },
  { reason: "run_key contains |", ...OK_MSG, run_key: "claim|demo" },
  { reason: "leaf_hash not 64 hex", ...OK_MSG, leaf_hash: "abcd" },
  { reason: "leaf_hash uppercase", ...OK_MSG, leaf_hash: "AB".repeat(32) },
  { reason: "unknown payout_kind", ...OK_MSG, payout_kind: "wire" },
  { reason: "payout_target contains newline", ...OK_MSG, payout_target: "asha\n.test.near" },
  { reason: "payout_target not a NEAR account", ...OK_MSG, payout_target: "Asha.Test.Near" },
  { reason: "contract_id not a NEAR account", ...OK_MSG, contract_id: "blindroll|x" },
];

export async function generateClaimVectors() {
  const merkle = generateMerkleVectors();
  const cases = [];
  for (const c of CLAIMS) {
    const tree = merkle.trees.find((t) => t.name === c.tree)!;
    const input: ClaimMessageInput = {
      contractId: c.contract_id,
      runKey: tree.run_key,
      leafHashHex: tree.leaf_hashes[c.leaf_index]!,
      payoutKind: c.payout_kind,
      payoutTarget: c.payout_target,
      destinationAsset: c.destination_asset,
      destinationAddress: c.destination_address,
      expiresAtMs: c.expires_at_ms,
    };
    const message = buildClaimMessage(input);
    cases.push({
      name: c.name,
      tree: c.tree,
      leaf_index: c.leaf_index,
      contract_id: c.contract_id,
      run_key: tree.run_key,
      leaf_hash: input.leafHashHex,
      payout_kind: c.payout_kind,
      payout_target: c.payout_target,
      destination_asset: c.destination_asset,
      destination_address: c.destination_address,
      expires_at_ms: c.expires_at_ms.toString(),
      message,
      eip191_hash: eip191HashHex(message),
      signer_address: c.signer.address.toLowerCase(),
      signature: await c.signer.signMessage({ message }),
      wrong_signer_signature: await c.wrongSigner.signMessage({ message }),
    });
  }
  return {
    description:
      "Shared claim-message vectors for packages/core (TypeScript) and contracts/blindroll (Rust). Signatures are personal_sign (EIP-191) by the public Hardhat/Anvil test keys #0/#1. Generated by packages/core/scripts/gen-vectors.ts; do not edit by hand.",
    version: 1,
    cases,
    invalid_messages: INVALID_MESSAGES,
  };
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
