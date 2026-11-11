import { NextResponse } from "next/server";
import { type RunCtx, handle, requireApprover, runDeps } from "@/lib/server/http";
import { finalize } from "@/lib/server/runs";

export const POST = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { claimDays?: unknown };
  const claimDays = typeof body.claimDays === "number" ? body.claimDays : undefined;
  return NextResponse.json(finalize(runDeps(), { accountId, runKey, claimDays }));
});
