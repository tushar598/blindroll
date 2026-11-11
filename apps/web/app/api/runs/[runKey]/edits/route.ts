import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/auth";
import { type RunCtx, handle, readJson, requireApprover, runDeps } from "@/lib/server/http";
import { addEdit } from "@/lib/server/runs";

/** `{kind:"set", rowNumber, column, value}` or `{kind:"remove", rowNumber, reason}`. Logged. */
export const POST = handle<RunCtx>(async (req, ctx) => {
  const accountId = await requireApprover(req);
  const { runKey } = await ctx.params;
  const b = await readJson(req);
  if (!Number.isInteger(b.rowNumber)) throw new HttpError(400, "bad_request", "rowNumber is required");
  const rowNumber = b.rowNumber as number;
  if (b.kind === "remove" && typeof b.reason === "string") {
    addEdit(runDeps(), { accountId, runKey, edit: { kind: "remove", rowNumber, reason: b.reason } });
  } else if (b.kind === "set" && typeof b.column === "string" && typeof b.value === "string") {
    addEdit(runDeps(), { accountId, runKey, edit: { kind: "set", rowNumber, column: b.column, value: b.value } });
  } else {
    throw new HttpError(400, "bad_request", "Unknown edit");
  }
  return NextResponse.json({ ok: true });
});
