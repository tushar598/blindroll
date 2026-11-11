import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { prepareClaim } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit, readJson, requireViewScope } from "@/lib/server/http";

/** `{optionId, receiver}` → the exact claim message to sign (EVM) or the claim_near call (NEAR). */
export const POST = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-prepare", 20);
  const { runKey } = await ctx.params;
  const scope = await requireViewScope(req, runKey);
  const b = await readJson(req);
  if (typeof b.optionId !== "string" || typeof b.receiver !== "string") throw new HttpError(400, "bad_request", "optionId and receiver are required");
  return NextResponse.json(await prepareClaim(claimDeps(), scope, { optionId: b.optionId, receiver: b.receiver }));
});
