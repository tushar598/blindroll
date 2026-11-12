"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { useNearWalletChoice, WalletPickerDialog } from "./near-wallet-choice";
import { useSession } from "./session";

export function SiteHeader() {
  const { me, busy, error, signIn, pendingSignIn, continueSignIn, signOut } = useSession();
  // Recipients on a claim page are not approvers: no approver sign-in there.
  const pathname = usePathname();
  const onClaimPage = pathname.startsWith("/claim/");
  // With more than one wallet offered, sign-in first asks which wallet to use.
  const wallet = useNearWalletChoice(me?.network);
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const startSignIn = () => (wallet.wallets.length > 1 ? setPicking(true) : void signIn());
  return (
    <header className="sticky top-0 z-40 border-b border-[#322E25]/15 backdrop-blur-sm bg-[#E9E1CD]/95">
      <div className="mx-auto flex w-full max-w-[1360px] h-14 items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/" className="inline-flex items-center gap-2.5 text-sm font-mono font-bold tracking-tight text-[#322E25] whitespace-nowrap shrink-0">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-5 h-5 font-black text-base tracking-tighter text-[#322E25]"
          >
            ⋈
          </span>
          <span className="text-base font-bold tracking-tight uppercase">
            Blindroll
          </span>
          <span className="text-[#322E25]/30 font-normal">
            |
          </span>
          <span className="text-[11px] tracking-widest uppercase text-[#322E25]/70 hidden sm:inline">
            PAYROLL
          </span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {me && <span className="font-mono border border-[#322E25]/25 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">{me.network}</span>}
          {onClaimPage ? null : me?.accountId ? (
            <>
              <span className="font-mono text-xs hidden sm:inline text-[#322E25]/70">{me.accountId}</span>
              <button className="btn-quiet" onClick={() => void signOut()} disabled={busy}>
                Sign out
              </button>
            </>
          ) : (
            me && (
              <button className="btn" onClick={startSignIn} disabled={busy}>
                {busy ? "Check your wallet…" : "Sign in with NEAR"}
              </button>
            )
          )}
        </div>
      </div>
      {pendingSignIn && !onClaimPage && !me?.accountId && (
        <div className="mx-auto w-full max-w-[1360px] px-5 sm:px-8 pb-2">
          <div className="flex flex-wrap items-center gap-3 border border-[#0667DC]/30 bg-[#e8f1fc] px-3 py-2 text-xs font-mono text-[#322E25]">
            <span>Wallet connected as {pendingSignIn}. One more click to sign the sign-in message (your browser blocked the second popup).</span>
            <button className="btn" onClick={() => void continueSignIn()} disabled={busy}>
              {busy ? "Check your wallet…" : "Sign message"}
            </button>
          </div>
        </div>
      )}
      {/* Sign-in errors from the header button; the home page shows its own. */}
      {error && !onClaimPage && pathname !== "/" && (
        <div className="mx-auto w-full max-w-[1360px] px-5 sm:px-8 pb-2">
          <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-xs font-mono text-[#a3271f]">{error}</p>
        </div>
      )}
      {picking && <WalletPickerDialog choice={wallet} onClose={closePicker} onPick={() => void signIn()} />}
    </header>
  );
}
