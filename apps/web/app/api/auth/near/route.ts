import { NextResponse } from "next/server";
import { HttpError, verifySignIn } from "@/lib/server/auth";
import { acceptedCallbackUrl } from "@/lib/server/nep413";
import { serverConfig } from "@/lib/server/config";
import { db } from "@/lib/server/db";
import { handle, readJson } from "@/lib/server/http";
import { isFullAccessKey } from "@/lib/server/rpc";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/server/session";

export const POST = handle(async (req) => {
  const b = await readJson(req);
  const { accountId, publicKey, signature, nonce } = b;
  if (typeof accountId !== "string" || typeof publicKey !== "string" || typeof signature !== "string" || typeof nonce !== "string") {
    throw new HttpError(400, "bad_request", "accountId, publicKey, signature and nonce are required");
  }
  // callbackUrl: only wallets that were given one (MyNearWallet) include it in the signed payload.
  const callbackUrl = acceptedCallbackUrl(b.callbackUrl, serverConfig().appUrl);
  const account = await verifySignIn(db(), { accountId, publicKey, signature, nonce, ...(callbackUrl ? { callbackUrl } : {}) }, isFullAccessKey);
  const res = NextResponse.json({ accountId: account });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(account), {
    httpOnly: true,
    sameSite: "lax",
    secure: serverConfig().appUrl.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
});
