import { NextResponse } from "next/server";
import { claimStatus } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, rateLimit, requireViewScope } from "@/lib/server/http";

export const GET = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-status", 60);
  const { runKey } = await ctx.params;
  return NextResponse.json(await claimStatus(claimDeps(), await requireViewScope(req, runKey)), { headers: { "Cache-Control": "no-store" } });
});
