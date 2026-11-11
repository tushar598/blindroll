import { NextResponse } from "next/server";
import { payoutOptions } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit, requireViewScope } from "@/lib/server/http";

export const GET = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-options", 30);
  const { runKey } = await ctx.params;
  return NextResponse.json(await payoutOptions(claimDeps(), await requireViewScope(req, runKey)), { headers: { "Cache-Control": "no-store" } });
});
