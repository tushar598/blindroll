import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { type RunCtx, handle } from "@/lib/server/http";
import { getReportJson } from "@/lib/server/runs";

/** Public: the canonical report bytes, exactly as hashed. No salaries, addresses or names (docs/05). */
export const GET = handle<RunCtx>(async (_req: NextRequest, ctx) => {
  const { runKey } = await ctx.params;
  const json = getReportJson(db(), runKey);
  if (json === null) return NextResponse.json({ error: { code: "not_found", message: "No report for this run" } }, { status: 404 });
  return new Response(json, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
});
