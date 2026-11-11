import { NextResponse } from "next/server";
import { SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, issueNonce } from "@/lib/server/auth";
import { db } from "@/lib/server/db";
import { handle } from "@/lib/server/http";

export const GET = handle(async () =>
  NextResponse.json({ nonce: issueNonce(db(), "sign_in"), message: SIGN_IN_MESSAGE, recipient: SIGN_IN_RECIPIENT }),
);
