import { bytesToHex, concatBytes, keccak256, utf8ToBytes } from "../hash.ts";
import {
  U64_MAX,
  ValidationError,
  assertHashHex,
  assertMessageField,
  assertNearAccountId,
  assertRunKey,
} from "../validate.ts";

export const PAYOUT_KINDS = ["near_ft", "oneclick"] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export interface ClaimMessageInput {
  /** The Blindroll contract account ID. */
  contractId: string;
  runKey: string;
  /** 64 lowercase hex chars. */
  leafHashHex: string;
  payoutKind: PayoutKind;
  /** NEAR account that receives the USDC: the recipient's account, or the 1Click deposit address. */
  payoutTarget: string;
  /** Informational: what the recipient expects to receive, e.g. a 1Click asset ID. */
  destinationAsset: string;
  /** Informational: where the recipient expects to receive it. */
  destinationAddress: string;
  expiresAtMs: bigint;
}

/**
 * The exact text an EVM recipient signs with personal_sign.
 * Must match contracts/blindroll/src/sig.rs byte for byte (vectors: test-vectors/claim-message.json).
 */
export function buildClaimMessage(input: ClaimMessageInput): string {
  assertNearAccountId(input.contractId, "contract_id");
  assertRunKey(input.runKey);
  assertHashHex(input.leafHashHex, "leaf_hash");
  if (!PAYOUT_KINDS.includes(input.payoutKind)) throw new ValidationError("payout_kind must be near_ft or oneclick");
  assertNearAccountId(input.payoutTarget, "payout_target");
  assertMessageField(input.destinationAsset, "destination_asset");
  assertMessageField(input.destinationAddress, "destination_address");
  if (typeof input.expiresAtMs !== "bigint" || input.expiresAtMs <= 0n || input.expiresAtMs > U64_MAX) {
    throw new ValidationError("expires_at_ms must be a positive u64 bigint");
  }
  return [
    "Blindroll claim v1",
    `contract: ${input.contractId}`,
    `run: ${input.runKey}`,
    `leaf: ${input.leafHashHex}`,
    `payout: ${input.payoutKind}:${input.payoutTarget}`,
    `to: ${input.destinationAsset}:${input.destinationAddress}`,
    `expires: ${input.expiresAtMs.toString(10)}`,
  ].join("\n");
}

/** keccak256("\x19Ethereum Signed Message:\n" + byteLength(message) + message) */
export function eip191Hash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak256(concatBytes(prefix, body));
}

export function eip191HashHex(message: string): string {
  return bytesToHex(eip191Hash(message));
}

export interface ViewMessageInput {
  runKey: string;
  /** The address being proven, in leaf format. */
  address: string;
  nonce: string;
  /** ISO-8601 timestamp. */
  issued: string;
}

/** Off-chain "view my payout" message (docs/07). Verified by the backend only. */
export function buildViewMessage(input: ViewMessageInput): string {
  assertRunKey(input.runKey);
  assertMessageField(input.address, "address");
  assertMessageField(input.nonce, "nonce");
  assertMessageField(input.issued, "issued");
  return [
    "Blindroll: view my payout",
    `run: ${input.runKey}`,
    `address: ${input.address}`,
    `nonce: ${input.nonce}`,
    `issued: ${input.issued}`,
  ].join("\n");
}
