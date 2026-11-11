import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { submitClaim } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit, readJson, requireViewScope } from "@/lib/server/http";

/** EVM: `{claimId, signature}` → the relayer submits claim_evm. NEAR: `{claimId, txHash}` after the wallet sent claim_near. */
export const POST = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-submit", 10);
  const { runKey } = await ctx.params;
  const scope = await requireViewScope(req, runKey);
  const b = await readJson(req);
  if (!Number.isInteger(b.claimId)) throw new HttpError(400, "bad_request", "claimId is required");
  return NextResponse.json(
    await submitClaim(claimDeps(), scope, {
      claimId: b.claimId as number,
      ...(typeof b.signature === "string" ? { signature: b.signature } : {}),
      ...(typeof b.txHash === "string" ? { txHash: b.txHash } : {}),
    }),
  );
});
