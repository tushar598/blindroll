import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { type RunCtx, handle } from "@/lib/server/http";
import { getAttestationText } from "@/lib/server/runs";

/** Public: the stored NEAR AI Cloud attestation, byte for byte (its sha256 is in the report). No payroll data. */
export const GET = handle<RunCtx>(async (_req: NextRequest, ctx) => {
  const { runKey } = await ctx.params;
  const text = getAttestationText(db(), runKey);
  if (text === null) return NextResponse.json({ error: { code: "not_found", message: "No AI attestation for this run" } }, { status: 404 });
  return new Response(text, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
});
