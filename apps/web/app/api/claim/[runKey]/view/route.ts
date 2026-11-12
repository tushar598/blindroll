import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { verifyView } from "@/lib/server/claims";
import { serverConfig } from "@/lib/server/config";
import { type RunCtx, claimDeps, handle, rateLimit, readJson } from "@/lib/server/http";
import { acceptedCallbackUrl } from "@/lib/server/nep413";

/** `{chain, address, nonce, issued, signature, publicKey?, callbackUrl?}` → own row + view token, or `404 not_listed`. */
export const POST = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-view", 20);
  const { runKey } = await ctx.params;
  const b = await readJson(req);
  const { chain, address, nonce, issued, signature, publicKey } = b;
  if ([chain, address, nonce, issued, signature].some((v) => typeof v !== "string")) throw new HttpError(400, "bad_request", "chain, address, nonce, issued and signature are required");
  const result = await verifyView(claimDeps(), {
    runKey, chain: chain as string, address: address as string, nonce: nonce as string, issued: issued as string,
    signature: signature as string, ...(typeof publicKey === "string" ? { publicKey } : {}),
    ...(acceptedCallbackUrl(b.callbackUrl, serverConfig().appUrl) ? { callbackUrl: b.callbackUrl as string } : {}),
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
