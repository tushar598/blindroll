import { NextResponse } from "next/server";
import { type RunCtx, handle, requireApprover, runDeps } from "@/lib/server/http";
import { viewFunction } from "@/lib/server/rpc";
import { syncRun } from "@/lib/server/runs";

/** Reads the run from the contract (real RPC view call) and stores its status. */
export const POST = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { createTx?: unknown };
  const createTx = typeof body.createTx === "string" ? body.createTx : undefined;
  return NextResponse.json(await syncRun(runDeps(), { accountId, runKey, createTx }, viewFunction));
});
