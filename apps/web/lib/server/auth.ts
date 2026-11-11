import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { isNearAccountId } from "@blindroll/core";
import { type Db, nonces, orgApprovers } from "./db";
import { verifyNep413Signature } from "./nep413";

export const SIGN_IN_MESSAGE = "Sign in to Blindroll as an approver";
export const SIGN_IN_RECIPIENT = "blindroll";
const NONCE_TTL_MS = 5 * 60 * 1000;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A one-time 32-byte nonce (base64), valid 5 minutes. */
export function issueNonce(db: Db, purpose: string, now = Date.now()): string {
  db.delete(nonces).where(lt(nonces.expiresAt, now)).run();
  const nonce = randomBytes(32).toString("base64");
  db.insert(nonces).values({ nonce, purpose, expiresAt: now + NONCE_TTL_MS, used: false }).run();
  return nonce;
}

/** Marks the nonce used; false if unknown, expired, already used or for another purpose. */
export function consumeNonce(db: Db, nonce: string, purpose: string, now = Date.now()): boolean {
  const r = db
    .update(nonces)
    .set({ used: true })
    .where(and(eq(nonces.nonce, nonce), eq(nonces.purpose, purpose), eq(nonces.used, false)))
    .returning({ expiresAt: nonces.expiresAt })
    .get();
  return r !== undefined && r.expiresAt >= now;
}

export function approverOrgIds(db: Db, accountId: string): string[] {
  return db.select({ orgId: orgApprovers.orgId }).from(orgApprovers).where(eq(orgApprovers.accountId, accountId)).all().map((r) => r.orgId);
}

/**
 * NEP-413 sign-in (docs/09): one-time nonce, valid signature, the key is a full-access key of the
 * account, and the account is an approver of an org. Returns the account ID.
 */
export async function verifySignIn(
  db: Db,
  input: { accountId: string; publicKey: string; signature: string; nonce: string },
  isFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>,
): Promise<string> {
  if (!isNearAccountId(input.accountId)) throw new HttpError(400, "bad_request", "accountId is not a valid NEAR account ID");
  if (!consumeNonce(db, input.nonce, "sign_in")) throw new HttpError(401, "bad_nonce", "The sign-in nonce is unknown, expired or already used");
  const ok = verifyNep413Signature({
    publicKey: input.publicKey,
    signatureBase64: input.signature,
    message: SIGN_IN_MESSAGE,
    nonce: new Uint8Array(Buffer.from(input.nonce, "base64")),
    recipient: SIGN_IN_RECIPIENT,
  });
  if (!ok) throw new HttpError(401, "bad_signature", "The wallet signature is not valid");
  if (!(await isFullAccessKey(input.accountId, input.publicKey))) {
    throw new HttpError(401, "key_not_owned", "That key is not a full-access key of the account");
  }
  if (approverOrgIds(db, input.accountId).length === 0) {
    throw new HttpError(403, "not_approver", "This account is not an approver of any organization");
  }
  return input.accountId;
}
