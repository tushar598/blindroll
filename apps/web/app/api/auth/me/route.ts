import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { homeOrgId } from "@/lib/server/auth";
import { DEMO_ORG, SANDBOX_LIMITS_PUBLIC, enabledNearWallets, isSandboxOrg, serverConfig } from "@/lib/server/config";
import { db, orgs } from "@/lib/server/db";
import { handle } from "@/lib/server/http";
import { SESSION_COOKIE, readSessionToken } from "@/lib/server/session";

/** Who is signed in, plus the public deployment info the UI needs. */
export const GET = handle(async (req) => {
  const c = serverConfig();
  const accountId = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  // The org this session works in: a real org, or (JUDGE_SANDBOX=1) the account's own sandbox org.
  const orgId = accountId === null ? null : homeOrgId(db(), accountId, c.judgeSandbox);
  const org = orgId === null ? undefined : db().select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).get();
  return NextResponse.json({
    accountId: org ? accountId : null,
    network: c.network,
    contractId: c.contractId,
    tokenId: c.tokenId,
    aiLive: c.aiLive,
    org: org ?? { id: DEMO_ORG.id, name: DEMO_ORG.name },
    /** enabled: any account may sign in and gets a sandbox. active: this session is a sandbox. */
    sandbox: { enabled: c.judgeSandbox, active: org !== undefined && isSandboxOrg(org.id), limits: SANDBOX_LIMITS_PUBLIC },
    wallets: enabledNearWallets(),
  });
});
