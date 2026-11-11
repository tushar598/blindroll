import { NextResponse } from "next/server";
import { MAX_CSV_BYTES } from "@blindroll/core";
import { HttpError } from "@/lib/server/auth";
import { db } from "@/lib/server/db";
import { handle, requireApprover, runDeps } from "@/lib/server/http";
import { createRun, listRuns } from "@/lib/server/runs";

export const GET = handle(async (req) => NextResponse.json({ runs: listRuns(db(), await requireApprover(req)) }));

/** multipart: file (CSV), name, orgId. */
export const POST = handle(async (req) => {
  const accountId = await requireApprover(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "bad_request", "Expected a multipart form upload");
  }
  const file = form.get("file");
  const name = form.get("name");
  const orgId = form.get("orgId");
  if (!(file instanceof File) || typeof name !== "string" || typeof orgId !== "string") {
    throw new HttpError(400, "bad_request", "file, name and orgId are required");
  }
  if (file.size > MAX_CSV_BYTES) throw new HttpError(400, "too_large", "The CSV file is larger than 2 MB");
  const result = await createRun(runDeps(), { accountId, orgId, name, csvBytes: new Uint8Array(await file.arrayBuffer()) });
  return NextResponse.json(result, { status: 201 });
});
