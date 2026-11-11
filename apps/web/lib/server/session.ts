import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "br_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  return new TextEncoder().encode(s);
}

/** Approver session: an HS256 JWT in an HTTP-only cookie, valid 8 hours (docs/09). */
export async function createSessionToken(accountId: string): Promise<string> {
  return new SignJWT({ kind: "approver" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/** Returns the approver's account ID, or null for a missing, expired or forged token. */
export async function readSessionToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return payload.kind === "approver" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export const VIEW_TTL_SECONDS = 20 * 60;

/** What a recipient proved with the view signature: one address in one run. */
export interface ViewScope {
  runKey: string;
  chain: string;
  address: string;
}

/** Short-lived recipient token scoped to (run_key, chain, address) (docs/09). Sent as a Bearer header. */
export async function createViewToken(scope: ViewScope): Promise<string> {
  return new SignJWT({ kind: "view", run: scope.runKey, chain: scope.chain })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(scope.address)
    .setIssuedAt()
    .setExpirationTime(`${VIEW_TTL_SECONDS}s`)
    .sign(secret());
}

export async function readViewToken(token: string | undefined, runKey: string): Promise<ViewScope | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (payload.kind !== "view" || payload.run !== runKey || typeof payload.chain !== "string" || typeof payload.sub !== "string") return null;
    return { runKey, chain: payload.chain, address: payload.sub };
  } catch {
    return null;
  }
}
