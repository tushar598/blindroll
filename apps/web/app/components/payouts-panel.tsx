"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { RunView } from "@/lib/client/types";
import { callContract, explorerTx } from "@/lib/client/wallet";
import { useSession } from "./session";

interface Payout {
  claimId: number;
  chain: string;
  address: string;
  amountDisplay: string;
  optionId: string;
  payoutKind: string;
  payoutTarget: string;
  destinationAddress: string;
  claimTx: string | null;
  simulated: boolean;
  payoutStatus: string | null;
  refundTx: string | null;
  reopenTx: string | null;
}
interface ReopenCall {
  contractId: string;
  methodName: string;
  args: object;
  gasTgas: number;
  depositYocto: string;
}

export function SimulatedBadge() {
  return <span className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">Simulated</span>;
}

const OPTION_LABELS: Record<string, string> = { "near-usdc": "USDC on NEAR", "oneclick:base:USDC": "USDC on Base", "oneclick:arb:USDC": "USDC on Arbitrum" };

/** Claims made so far. For simulated cross-chain payouts: refund (a real transfer back) → reopen. */
export function PayoutsPanel({ run }: { run: RunView }) {
  const { me } = useSession();
  const [payouts, setPayouts] = useState<Payout[] | null>(null);
  const [simSink, setSimSink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ payouts: Payout[]; simSinkAccountId: string | null }>(`/api/runs/${run.runKey}/payouts`).then((r) => {
        setPayouts(r.payouts);
        setSimSink(r.simSinkAccountId);
      }),
    [run.runKey],
  );
  useEffect(() => {
    load().catch((err) => setError(errorMessage(err)));
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  const refund = (p: Payout) => act(`refund-${p.claimId}`, () => api(`/api/runs/${run.runKey}/payouts/${p.claimId}/refund`, { method: "POST" }));
  const reopen = (p: Payout) =>
    act(`reopen-${p.claimId}`, async () => {
      const call = await api<ReopenCall>(`/api/runs/${run.runKey}/payouts/${p.claimId}/reopen`);
      if (!me?.accountId) throw new Error("Sign in as an approver first");
      const { txHash } = await callContract(run.network, { signerId: me.accountId, receiverId: call.contractId, methodName: call.methodName, args: call.args, gasTgas: call.gasTgas, depositYocto: call.depositYocto });
      await api(`/api/runs/${run.runKey}/payouts/${p.claimId}/reopen`, { json: { txHash } });
    });

  if (payouts === null) return <p className="text-sm text-muted">{error ?? "Loading claims…"}</p>;
  return (
    <div className="space-y-3">
      {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}
      {payouts.length === 0 && <p className="card p-5 text-sm text-muted">No claims yet.</p>}
      {payouts.map((p) => (
        <div key={p.claimId} className="card p-5 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="num break-all text-xs">{p.address}</p>
            <p className="num">{p.amountDisplay} USDC</p>
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-medium">{OPTION_LABELS[p.optionId] ?? p.optionId}</span>
            {p.simulated && <SimulatedBadge />}
            <span className="text-muted">
              {!p.simulated && "Delivered: paid to "}
              {!p.simulated && <span className="num">{p.payoutTarget}</span>}
              {p.payoutStatus === "delivered_simulated" && "Delivered (simulated)"}
              {p.payoutStatus === "refunding" && "Refund transfer in progress…"}
              {p.payoutStatus === "refunded_simulated" && "Refunded (simulated failure, real refund)"}
              {p.payoutStatus === "reopened" && "Refunded and reopened: the recipient can claim again"}
            </span>
          </p>
          {p.simulated && (
            <p className="mt-1 text-xs leading-5 text-muted">
              Nothing was delivered to <span className="num">{p.destinationAddress}</span>: 1Click has no testnet. The contract really paid the test USDC to the holding account{" "}
              <span className="num">{p.payoutTarget}</span>.
            </p>
          )}
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {p.claimTx && <a className="underline" href={explorerTx(run.network, p.claimTx)} target="_blank" rel="noreferrer">Claim transaction</a>}
            {p.refundTx && <a className="underline" href={explorerTx(run.network, p.refundTx)} target="_blank" rel="noreferrer">Refund transaction (real transfer back to the contract)</a>}
            {p.reopenTx && <a className="underline" href={explorerTx(run.network, p.reopenTx)} target="_blank" rel="noreferrer">Reopen transaction</a>}
          </p>
          {p.simulated && p.payoutStatus === "delivered_simulated" && (
            <div className="mt-3">
              <button className="btn-quiet" disabled={busy !== null || simSink === null} onClick={() => void refund(p)}>
                {busy === `refund-${p.claimId}` ? "Sending the refund transfer…" : "Simulate a failed delivery and refund"}
              </button>
              <p className="mt-1 text-xs text-muted">
                The failure is simulated; the refund is real: the holding account sends {p.amountDisplay} USDC back to the contract.
              </p>
            </div>
          )}
          {p.simulated && p.payoutStatus === "refunded_simulated" && (
            <div className="mt-3">
              <button className="btn" disabled={busy !== null || !p.refundTx} onClick={() => void reopen(p)}>
                {busy === `reopen-${p.claimId}` ? "Confirm in your wallet…" : "Reopen claim"}
              </button>
              <p className="mt-1 text-xs text-muted">Check the refund transaction above first. Reopening lets this recipient claim again.</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
