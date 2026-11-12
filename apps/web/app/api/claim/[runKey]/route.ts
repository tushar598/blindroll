import { NextResponse } from "next/server";
import { publicRunInfo } from "@/lib/server/claims";
import { enabledNearWallets } from "@/lib/server/config";
import { type RunCtx, claimDeps, handle, rateLimit } from "@/lib/server/http";

/** Public run info: org name, run name, deadline, status. No amounts, no list. */
export const GET = handle<RunCtx>(async (req, ctx) => {
  rateLimit(req, "claim-info", 60);
  const { runKey } = await ctx.params;
  return NextResponse.json({ ...publicRunInfo(claimDeps(), runKey), wallets: enabledNearWallets() }, { headers: { "Cache-Control": "no-store" } });
});
