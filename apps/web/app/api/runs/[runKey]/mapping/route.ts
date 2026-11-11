import { NextResponse } from "next/server";
import { type RunCtx, handle, readJson, requireApprover, runDeps } from "@/lib/server/http";
import { setManualMapping } from "@/lib/server/runs";

/** Manual column mapping (the fallback when the AI is off or its reply was invalid). */
export const PUT = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  setManualMapping(runDeps(), { accountId, runKey, mapping: await readJson(req) });
  return NextResponse.json({ ok: true });
});
