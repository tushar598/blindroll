import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { isNearAccountId } from "@blindroll/core";
import { isSandboxOrg } from "./config";
import { type Db, nonces, orgApprovers } from "./db";
import { ensureSandboxOrg } from "./sandbox";
import { normalizeEd25519PublicKey, verifyNep413Any } from "./nep413";

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

/**
 * Orgs the account is an approver of. Sandbox orgs count only while JUDGE_SANDBOX=1, so turning
 * the switch off also signs sandbox users out (their rows stay in the database).
 */
export function approverOrgIds(db: Db, accountId: string, judgeSandbox: boolean): string[] {
  return db.select({ orgId: orgApprovers.orgId }).from(orgApprovers).where(eq(orgApprovers.accountId, accountId)).all()
    .map((r) => r.orgId)
    .filter((id) => judgeSandbox || !isSandboxOrg(id));
}

/** The org the UI works in: a real org when the account has one, otherwise its sandbox org. */
export function homeOrgId(db: Db, accountId: string, judgeSandbox: boolean): string | null {
  const ids = approverOrgIds(db, accountId, judgeSandbox);
  return ids.find((id) => !isSandboxOrg(id)) ?? ids[0] ?? null;
}

const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
function implicitAccountError(accountId: string): HttpError {
  return new HttpError(
    401,
    "implicit_account",
    `The wallet connected the implicit account ${accountId.slice(0, 8)}…${accountId.slice(-8)} (its address made from the key), not your named account. Approvers are named accounts such as name.testnet. In the wallet, add the account by its name, or use another wallet.`,
  );
}

/**
 * NEP-413 sign-in (docs/09): one-time nonce, valid signature, the key is a full-access key of the
 * account, and the account is an approver of an org. Returns the account ID.
 *
 * Judge sandbox (`judgeSandbox`, JUDGE_SANDBOX=1): an account that passes the same checks but is not
 * an approver of a real org gets its own sandbox org (created once, reused afterwards).
 */
export async function verifySignIn(
  db: Db,
  input: { accountId: string; publicKey: string; signature: string; nonce: string; callbackUrl?: string },
  isFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>,
  opts: { judgeSandbox?: boolean } = {},
): Promise<string> {
  if (!isNearAccountId(input.accountId)) throw new HttpError(400, "bad_request", "accountId is not a valid NEAR account ID");
  if (!consumeNonce(db, input.nonce, "sign_in")) throw new HttpError(401, "bad_nonce", "The sign-in nonce is unknown, expired or already used");
  const publicKey = normalizeEd25519PublicKey(input.publicKey);
  if (!publicKey) throw new HttpError(400, "bad_request", "publicKey is not an ed25519 public key");
  const ok = verifyNep413Any({
    publicKey,
    signatureBase64: input.signature,
    message: SIGN_IN_MESSAGE,
    nonce: new Uint8Array(Buffer.from(input.nonce, "base64")),
    recipient: SIGN_IN_RECIPIENT,
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  });
  if (!ok) throw new HttpError(401, "bad_signature", "The wallet signature is not valid");
  if (!(await isFullAccessKey(input.accountId, publicKey))) {
    if (IMPLICIT_ACCOUNT_RE.test(input.accountId)) throw implicitAccountError(input.accountId);
    throw new HttpError(
      401,
      "key_not_owned",
      `The wallet signed with a key that is not a full-access key of ${input.accountId}. If you imported this account into the wallet with a seed phrase, the wallet may have derived a different key: import it with the account's private key instead.`,
    );
  }
  const judgeSandbox = opts.judgeSandbox === true;
  // An approver of a real org signs in exactly as before, sandbox or not.
  if (approverOrgIds(db, input.accountId, false).length > 0) return input.accountId;
  if (!judgeSandbox) throw new HttpError(403, "not_approver", "This account is not an approver of any organization");
  // Sandbox orgs are for named accounts only, like approvers everywhere else.
  if (IMPLICIT_ACCOUNT_RE.test(input.accountId)) throw implicitAccountError(input.accountId);
  ensureSandboxOrg(db, input.accountId);
  return input.accountId;
}
