import { NextResponse } from "next/server";
import { issueViewChallenge } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit } from "@/lib/server/http";

/** One-time nonce and timestamp for the "view my payout" message. */
export const GET = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-challenge", 30);
  const { runKey } = await ctx.params;
  return NextResponse.json(issueViewChallenge(claimDeps(), runKey), { headers: { "Cache-Control": "no-store" } });
});
