import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { refundSimulatedPayout } from "@/lib/server/claims";
import { claimDeps, handle, requireApprover } from "@/lib/server/http";

type Ctx = { params: Promise<{ runKey: string; claimId: string }> };

/**
 * TESTNET SIMULATION of a 1Click refund. The refund itself is real: the sim sink transfers the
 * claimed USDC back to the contract. Response includes `simulated: true` and the refund tx.
 */
export const POST = handle<Ctx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey, claimId } = await ctx.params;
  if (!/^\d{1,9}$/.test(claimId)) throw new HttpError(400, "bad_request", "claimId must be a number");
  return NextResponse.json(await refundSimulatedPayout(claimDeps(), { accountId, runKey, claimId: Number(claimId) }));
});
