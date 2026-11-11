import { NextResponse } from "next/server";
import { listPayouts } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, requireApprover } from "@/lib/server/http";

/** Confirmed claims of the run with their payout state. Simulated ones carry `simulated: true`. */
export const GET = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  return NextResponse.json(listPayouts(claimDeps(), { accountId, runKey }), { headers: { "Cache-Control": "no-store" } });
});
