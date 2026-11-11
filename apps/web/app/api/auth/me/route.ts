import { NextResponse } from "next/server";
import { approverOrgIds } from "@/lib/server/auth";
import { DEMO_ORG, serverConfig } from "@/lib/server/config";
import { db } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { SESSION_COOKIE, readSessionToken } from "@/lib/server/session";

/** Who is signed in, plus the public deployment info the UI needs. */
export const GET = handle(async (req) => {
  const c = serverConfig();
  const accountId = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  const isApprover = accountId !== null && approverOrgIds(db(), accountId).length > 0;
  return NextResponse.json({
    accountId: isApprover ? accountId : null,
    network: c.network,
    contractId: c.contractId,
    tokenId: c.tokenId,
    aiLive: c.aiLive,
    org: { id: DEMO_ORG.id, name: DEMO_ORG.name },
  });
});
