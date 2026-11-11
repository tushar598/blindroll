import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { type RunCtx, handle, readJson, requireApprover, runDeps } from "@/lib/server/http";
import { addOverride } from "@/lib/server/runs";

export const POST = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const b = await readJson(req);
  if (typeof b.findingId !== "string" || typeof b.reason !== "string") throw new HttpError(400, "bad_request", "findingId and reason are required");
  addOverride(runDeps(), { accountId, runKey, findingId: b.findingId, reason: b.reason });
  return NextResponse.json({ ok: true });
});
