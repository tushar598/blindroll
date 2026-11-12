import { NextResponse } from "next/server";
import { type RunCtx, handle, requireApprover, runDeps } from "@/lib/server/http";
import { finalize } from "@/lib/server/runs";

export const POST = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { claimDays?: unknown; claimMinutes?: unknown };
  const claimDays = typeof body.claimDays === "number" ? body.claimDays : undefined;
  // Test networks only (refused on mainnet): a window in minutes, to try reclaim without waiting days.
  const claimMinutes = typeof body.claimMinutes === "number" ? body.claimMinutes : undefined;
  return NextResponse.json(finalize(runDeps(), { accountId, runKey, claimDays, ...(claimMinutes !== undefined ? { claimMinutes } : {}) }));
});
