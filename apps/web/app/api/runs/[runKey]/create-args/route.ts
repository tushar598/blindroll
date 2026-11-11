import { NextResponse } from "next/server";
import { type RunCtx, handle, requireApprover, runDeps } from "@/lib/server/http";
import { getCreateArgs } from "@/lib/server/runs";

export const GET = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  return NextResponse.json(getCreateArgs(runDeps(), { accountId, runKey }), { headers: { "Cache-Control": "no-store" } });
});
