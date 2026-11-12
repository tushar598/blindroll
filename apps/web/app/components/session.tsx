"use client";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { configureWallets, connectWallet, disconnectWallet, isPopupBlockedError, signInMessage } from "@/lib/client/wallet";

export interface Me {
  accountId: string | null;
  network: string;
  contractId: string;
  tokenId: string;
  aiLive: boolean;
  org: { id: string; name: string };
  /** NEAR wallet IDs this deployment offers (Meteor always). */
  wallets?: string[];
  /** Judge sandbox: `enabled` = any testnet account can sign in; `active` = this session is a sandbox org. */
  sandbox?: { enabled: boolean; active: boolean; limits: SandboxLimits };
}

export interface SandboxLimits {
  runsPerDay: number;
  maxRows: number;
  maxTotalUsdc: number;
  aiCallsPerDay: number;
  relayedClaimsPerDay: number;
  defaultClaimMinutes: number;
}

/** Applies the deployment's wallet list before anything can use a wallet. */
function withWallets(me: Me): Me {
  configureWallets(me.wallets);
  return me;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  /** Set when the wallet connected but its signing popup was blocked: one more click finishes sign-in. */
  pendingSignIn: string | null;
  continueSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSignIn, setPendingSignIn] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(withWallets(await api<Me>("/api/auth/me")));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    api<Me>("/api/auth/me")
      .then((m) => live && setMe(withWallets(m)))
      .catch((err) => live && setError(errorMessage(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  /** Signs the sign-in message with the connected wallet and starts the session. */
  const signStep = useCallback(
    async (network: string, accountId: string) => {
      const { nonce, message, recipient } = await api<{ nonce: string; message: string; recipient: string }>("/api/auth/nonce");
      const signed = await signInMessage(network, { message, recipient, nonceBase64: nonce });
      await api("/api/auth/near", {
        json: { accountId: signed.accountId || accountId, publicKey: signed.publicKey, signature: signed.signature, nonce, ...("callbackUrl" in signed ? { callbackUrl: signed.callbackUrl } : {}) },
      });
      await refresh();
    },
    [refresh],
  );

  const runSignIn = useCallback(
    async (connectFirst: boolean) => {
      if (!me) return;
      setBusy(true);
      setError(null);
      let accountId = pendingSignIn;
      try {
        if (connectFirst || !accountId) accountId = await connectWallet(me.network, me.contractId);
        setPendingSignIn(null);
        await signStep(me.network, accountId);
      } catch (err) {
        if (accountId && isPopupBlockedError(err)) {
          // The connect popup used up this click; the signing popup needs a new one.
          setPendingSignIn(accountId);
        } else {
          setError(errorMessage(err));
          // Forget the wallet connection, so the next try asks which account to use (the remembered
          // one may be a recipient's account from the claim page, or one this wallet no longer has).
          await disconnectWallet(me.network);
        }
      } finally {
        setBusy(false);
      }
    },
    [me, pendingSignIn, signStep],
  );
  const signIn = useCallback(() => runSignIn(true), [runSignIn]);
  const continueSignIn = useCallback(() => runSignIn(false), [runSignIn]);

  const signOut = useCallback(async () => {
    if (!me) return;
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      await disconnectWallet(me.network);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [me, refresh]);

  const value = useMemo(
    () => ({ me, loading, busy, error, signIn, pendingSignIn, continueSignIn, signOut }),
    [me, loading, busy, error, signIn, pendingSignIn, continueSignIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
