import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { prepareClaim } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit, readJson, requireViewScope } from "@/lib/server/http";

/** `{optionId, receiver?}` → the exact claim message to sign (EVM); NEAR: a gas-free relayed claim (own account) or the claim_near call. */
export const POST = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-prepare", 20);
  const { runKey } = await ctx.params;
  const scope = await requireViewScope(req, runKey);
  const b = await readJson(req);
  // `receiver` is only used by "USDC on NEAR"; cross-chain options pay the recipient's own verified address.
  if (typeof b.optionId !== "string" || (b.receiver !== undefined && typeof b.receiver !== "string")) throw new HttpError(400, "bad_request", "optionId is required");
  return NextResponse.json(await prepareClaim(claimDeps(), scope, { optionId: b.optionId, ...(typeof b.receiver === "string" ? { receiver: b.receiver } : {}) }));
});
