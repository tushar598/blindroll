import { bytesToHex, sha256, utf8ToBytes } from "../hash.ts";
import {
  EVM_ADDRESS_RE,
  SALT_HEX_RE,
  SOLANA_ADDRESS_RE,
  ValidationError,
  amountToString,
  assertRunKey,
  isNearAccountId,
} from "../validate.ts";

export const LEAF_PREFIX = "blindroll:leaf:v1";
export const CHAINS = ["near", "evm", "solana"] as const;
export type Chain = (typeof CHAINS)[number];

/** One recipient row. `amount` is USDC base units (6 decimals). */
export interface Leaf {
  chain: Chain;
  /** NEAR account ID as-is; EVM lowercase 0x + 40 hex; Solana base58. */
  address: string;
  amount: bigint;
  /** 32 lowercase hex chars (16 random bytes). */
  saltHex: string;
}

/** JSON shape used at API boundaries and as the contract's `leaf` argument. */
export interface LeafJson {
  chain: Chain;
  address: string;
  amount: string;
  salt_hex: string;
}

export function assertLeaf(leaf: Leaf): void {
  if (!CHAINS.includes(leaf.chain)) throw new ValidationError("chain must be near, evm or solana");
  const a = leaf.address;
  if (typeof a !== "string") throw new ValidationError("address must be a string");
  const ok =
    leaf.chain === "evm"
      ? EVM_ADDRESS_RE.test(a)
      : leaf.chain === "near"
        ? isNearAccountId(a)
        : SOLANA_ADDRESS_RE.test(a);
  if (!ok) throw new ValidationError(`address is not a valid ${leaf.chain} address`);
  amountToString(leaf.amount);
  if (typeof leaf.saltHex !== "string" || !SALT_HEX_RE.test(leaf.saltHex)) {
    throw new ValidationError("salt_hex must be 32 lowercase hex chars");
  }
}

/** `blindroll:leaf:v1|run_key|chain|address|amount|salt_hex` */
export function leafPreimage(runKey: string, leaf: Leaf): string {
  assertRunKey(runKey);
  assertLeaf(leaf);
  return [LEAF_PREFIX, runKey, leaf.chain, leaf.address, amountToString(leaf.amount), leaf.saltHex].join("|");
}

export function leafHash(runKey: string, leaf: Leaf): Uint8Array {
  return sha256(utf8ToBytes(leafPreimage(runKey, leaf)));
}

export function leafHashHex(runKey: string, leaf: Leaf): string {
  return bytesToHex(leafHash(runKey, leaf));
}

export function leafToJson(leaf: Leaf): LeafJson {
  assertLeaf(leaf);
  return { chain: leaf.chain, address: leaf.address, amount: amountToString(leaf.amount), salt_hex: leaf.saltHex };
}
