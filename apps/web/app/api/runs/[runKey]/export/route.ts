import { NextResponse } from "next/server";
import { exportRun, exportToCsv } from "@/lib/server/claims";
import { type RunCtx, claimDeps, handle, requireApprover } from "@/lib/server/http";

/** Reconciled export, approvers only: `?format=csv` (default) or `?format=json`. */
export const GET = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const data = await exportRun(claimDeps(), { accountId, runKey });
  if (req.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="blindroll-${runKey}.json"` } });
  }
  return new Response(exportToCsv(data.rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="blindroll-${runKey}.csv"` },
  });
});
