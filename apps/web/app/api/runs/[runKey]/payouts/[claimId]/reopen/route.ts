import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { getReopenCall, recordReopen } from "@/lib/server/claims";
import { claimDeps, handle, requireApprover } from "@/lib/server/http";

type Ctx = { params: Promise<{ runKey: string; claimId: string }> };

function parseId(claimId: string): number {
  if (!/^\d{1,9}$/.test(claimId)) throw new HttpError(400, "bad_request", "claimId must be a number");
  return Number(claimId);
}

/** The reopen_claim call for the approver's wallet. 409 until the refund transfer has gone through. */
export const GET = handle<Ctx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey, claimId } = await ctx.params;
  return NextResponse.json(getReopenCall(claimDeps(), { accountId, runKey, claimId: parseId(claimId) }), { headers: { "Cache-Control": "no-store" } });
});

/** `{txHash}` after the approver sent reopen_claim; recorded once the contract shows the leaf unclaimed. */
export const POST = handle<Ctx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey, claimId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { txHash?: unknown };
  return NextResponse.json(
    await recordReopen(claimDeps(), { accountId, runKey, claimId: parseId(claimId), ...(typeof body.txHash === "string" ? { txHash: body.txHash } : {}) }),
  );
});
