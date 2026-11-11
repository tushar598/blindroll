"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "./session";

export function SiteHeader() {
  const { me, busy, signIn, signOut } = useSession();
  // Recipients on a claim page are not approvers: no approver sign-in there.
  const onClaimPage = usePathname().startsWith("/claim/");
  return (
    <header className="border-b border-line bg-card">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-tight">Blindroll</span>
          <span className="hidden text-sm text-muted sm:inline">claim-based payroll on NEAR</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {me && <span className="num rounded border border-line px-2 py-0.5 text-xs uppercase text-muted">{me.network}</span>}
          {onClaimPage ? null : me?.accountId ? (
            <>
              <span className="num hidden sm:inline">{me.accountId}</span>
              <button className="btn-quiet" onClick={() => void signOut()} disabled={busy}>
                Sign out
              </button>
            </>
          ) : (
            me && (
              <button className="btn" onClick={() => void signIn()} disabled={busy}>
                {busy ? "Check your wallet…" : "Sign in with NEAR"}
              </button>
            )
          )}
        </div>
      </div>
    </header>
  );
}
