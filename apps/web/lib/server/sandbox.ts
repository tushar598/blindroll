import { and, eq, gte, sql } from "drizzle-orm";
import { SANDBOX, isSandboxOrg, sandboxOrgId } from "./config";
import { type Db, orgApprovers, orgs, runs, sandboxUsage } from "./db";

// Judge sandbox (docs/02 Flow D, docs/09 "Judge sandbox"): the per-account org and its daily counters.
// better-sqlite3 is synchronous, so a check followed by a bump with no `await` in between is atomic
// in this single-process app.

export type UsageKind = "ai" | "relay";

/** The UTC day, `YYYY-MM-DD`. All sandbox limits reset at 00:00 UTC. */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * Creates the account's sandbox org if it does not exist yet: the account is the only approver
 * (threshold 1) and the refund account. Signing in again reuses it.
 */
export function ensureSandboxOrg(db: Db, accountId: string): string {
  const id = sandboxOrgId(accountId);
  db.transaction((tx) => {
    tx.insert(orgs).values({ id, name: `Sandbox – ${accountId}`, threshold: 1, refundAccount: accountId, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    tx.insert(orgApprovers).values({ orgId: id, accountId, position: 0 }).onConflictDoNothing().run();
  });
  return id;
}

export function usageCount(db: Db, accountId: string, kind: UsageKind, day = utcDay()): number {
  return db.select({ count: sandboxUsage.count }).from(sandboxUsage)
    .where(and(eq(sandboxUsage.accountId, accountId), eq(sandboxUsage.day, day), eq(sandboxUsage.kind, kind))).get()?.count ?? 0;
}

/** Today's total over every sandbox account. */
export function globalUsageCount(db: Db, kind: UsageKind, day = utcDay()): number {
  return db.select({ total: sql<number>`coalesce(sum(${sandboxUsage.count}), 0)` }).from(sandboxUsage)
    .where(and(eq(sandboxUsage.day, day), eq(sandboxUsage.kind, kind))).get()?.total ?? 0;
}

export function bumpUsage(db: Db, accountId: string, kind: UsageKind, day = utcDay()): void {
  db.insert(sandboxUsage).values({ accountId, day, kind, count: 1 })
    .onConflictDoUpdate({ target: [sandboxUsage.accountId, sandboxUsage.day, sandboxUsage.kind], set: { count: sql`${sandboxUsage.count} + 1` } }).run();
}

/** Runs the sandbox org started today (UTC). Runs cannot be deleted, so the runs table is the counter. */
export function sandboxRunsToday(db: Db, orgId: string, now = Date.now()): number {
  if (!isSandboxOrg(orgId)) return 0;
  return db.select({ n: sql<number>`count(*)` }).from(runs).where(and(eq(runs.orgId, orgId), gte(runs.createdAt, `${utcDay(now)}T00:00:00.000Z`))).get()?.n ?? 0;
}

export { SANDBOX };
