/**
 * Shared input validation for everything that gets hashed or signed.
 * The Rust contract (contracts/blindroll/src/merkle.rs, sig.rs) applies the same rules;
 * see docs/04-smart-contract-spec.md → "Input validation".
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const RUN_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const SALT_HEX_RE = /^[0-9a-f]{32}$/;
export const HASH_HEX_RE = /^[0-9a-f]{64}$/;
/** Printable ASCII (space..~) without the leaf delimiter `|`, 1..=128 chars. */
export const MESSAGE_FIELD_RE = /^[\x20-\x7b\x7d\x7e]{1,128}$/;

export const U128_MAX = (1n << 128n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;

export function assertRunKey(runKey: string): void {
  if (typeof runKey !== "string" || !RUN_KEY_RE.test(runKey)) {
    throw new ValidationError("run_key must match [A-Za-z0-9_-]{1,64}");
  }
}

export function isNearAccountId(id: string): boolean {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && NEAR_ACCOUNT_RE.test(id);
}

export function assertNearAccountId(id: string, field: string): void {
  if (!isNearAccountId(id)) throw new ValidationError(`${field} is not a valid NEAR account ID`);
}

export function assertHashHex(hex: string, field: string): void {
  if (typeof hex !== "string" || !HASH_HEX_RE.test(hex)) {
    throw new ValidationError(`${field} must be 64 lowercase hex chars`);
  }
}

/** Free-form signed-message field: printable ASCII, no `|`, no newlines, 1..=128 chars. */
export function assertMessageField(value: string, field: string): void {
  if (typeof value !== "string" || !MESSAGE_FIELD_RE.test(value)) {
    throw new ValidationError(`${field} must be 1-128 printable ASCII chars without '|' or newlines`);
  }
}

/** Canonical decimal string for a positive u128 amount in base units. */
export function amountToString(amount: bigint): string {
  if (typeof amount !== "bigint") throw new ValidationError("amount must be a bigint");
  if (amount <= 0n || amount > U128_MAX) throw new ValidationError("amount must be in 1..=u128::MAX");
  return amount.toString(10);
}

/** Parses a canonical decimal string (no sign, no leading zeros) into a positive u128 bigint. */
export function parseAmount(s: string): bigint {
  if (typeof s !== "string" || !/^[1-9][0-9]{0,38}$/.test(s)) {
    throw new ValidationError("amount must be a canonical positive decimal string");
  }
  const v = BigInt(s);
  if (v > U128_MAX) throw new ValidationError("amount exceeds u128");
  return v;
}
