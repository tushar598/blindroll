"use client";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { connectWallet, disconnectWallet, signInMessage } from "@/lib/client/wallet";

export interface Me {
  accountId: string | null;
  network: string;
  contractId: string;
  tokenId: string;
  aiLive: boolean;
  org: { id: string; name: string };
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  signIn: () => Promise<void>;
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

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    api<Me>("/api/auth/me")
      .then((m) => live && setMe(m))
      .catch((err) => live && setError(errorMessage(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      const accountId = await connectWallet(me.network, me.contractId);
      const { nonce, message, recipient } = await api<{ nonce: string; message: string; recipient: string }>("/api/auth/nonce");
      const signed = await signInMessage(me.network, { message, recipient, nonceBase64: nonce });
      await api("/api/auth/near", { json: { accountId: signed.accountId || accountId, publicKey: signed.publicKey, signature: signed.signature, nonce } });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [me, refresh]);

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

  const value = useMemo(() => ({ me, loading, busy, error, signIn, signOut }), [me, loading, busy, error, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
