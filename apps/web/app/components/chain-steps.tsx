"use client";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { RunView } from "@/lib/client/types";
import { callContract, explorerAccount, explorerTx } from "@/lib/client/wallet";

interface CreateArgs {
  contractId: string;
  args: Record<string, unknown>;
  depositYocto: string;
}

const formatUsdc = (base: string) => {
  const n = BigInt(base);
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${(n / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

/** create_run → approve_run (threshold) → fund. Each step is a real transaction from a wallet or the NEAR CLI. */
export function ChainSteps({ run, accountId, onChanged }: { run: RunView; accountId: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const chain = run.chain;
  const fin = run.finalized!;
  const net = `network-config ${run.network}`;

  async function sync(createTx?: string | null) {
    await api(`/api/runs/${run.runKey}/sync`, { json: createTx ? { createTx } : {} });
    await onChanged();
  }

  // Other approvers act from the CLI, so the page re-reads the contract by itself every few
  // seconds until the run is fully funded (or closed/cancelled).
  const waiting = !chain || ["draft", "approved"].includes(chain.status.toLowerCase());
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy !== null;
  }, [busy]);
  const { runKey } = run;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (busyRef.current || document.visibilityState !== "visible") return;
      api(`/api/runs/${runKey}/sync`, { json: {} })
        .then(() => onChanged())
        .catch(() => undefined); // the manual button shows errors
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, runKey, onChanged]);

  async function act(name: string, fn: () => Promise<string | null>, isCreate = false) {
    setBusy(name);
    setError(null);
    try {
      const tx = await fn();
      setLastTx(tx);
      await sync(isCreate ? tx : null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const create = () =>
    act("create", async () => {
      const c = await api<CreateArgs>(`/api/runs/${run.runKey}/create-args`);
      return (await callContract(run.network, { receiverId: c.contractId, methodName: "create_run", args: c.args, gasTgas: 30, depositYocto: c.depositYocto })).txHash;
    }, true);
  const approve = () =>
    act("approve", async () => (await callContract(run.network, { receiverId: run.contractId, methodName: "approve_run", args: { run_key: run.runKey }, gasTgas: 30, depositYocto: "0" })).txHash);
  const fund = () =>
    act("fund", async () => {
      const remaining = (BigInt(chain!.total_amount) - BigInt(chain!.funded_amount)).toString();
      return (
        await callContract(run.network, {
          receiverId: run.tokenId,
          methodName: "ft_transfer_call",
          args: { receiver_id: run.contractId, amount: remaining, msg: JSON.stringify({ fund_run: run.runKey }) },
          gasTgas: 100,
          depositYocto: "1",
        })
      ).txHash;
    });

  const approvals = chain?.approvals ?? [];
  const iApproved = approvals.includes(accountId);
  const status = chain?.status.toLowerCase() ?? "not_created";
  const remaining = chain ? (BigInt(chain.total_amount) - BigInt(chain.funded_amount)).toString() : fin.totalAmount;
  const cliApprove = (who: string) =>
    `near contract call-function as-transaction ${run.contractId} approve_run json-args '{"run_key":"${run.runKey}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${who} ${net} sign-with-keychain send`;
  const cliFund = (who: string) =>
    `near contract call-function as-transaction ${run.tokenId} ft_transfer_call json-args '{"receiver_id":"${run.contractId}","amount":"${remaining}","msg":"{\\"fund_run\\":\\"${run.runKey}\\"}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${who} ${net} sign-with-keychain send`;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}
      {lastTx && (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
          Transaction sent:{" "}
          <a className="num underline" href={explorerTx(run.network, lastTx)} target="_blank" rel="noreferrer">{lastTx}</a>
        </p>
      )}

      <Step title="Create the run on-chain" state={chain ? "done" : "now"}>
        <p className="text-sm leading-6 text-muted">
          Stores the Merkle root, the report hash, the approvers and the deadline in{" "}
          <a className="num underline" href={explorerAccount(run.network, run.contractId)} target="_blank" rel="noreferrer">{run.contractId}</a>. No row data goes on-chain.
          You pay a small storage deposit; the contract refunds what it does not use.
        </p>
        {chain ? (
          <p className="mt-2 text-sm">
            Created by <span className="num">{chain.creator}</span>
            {run.createTx && (
              <>
                {" · "}
                <a className="underline" href={explorerTx(run.network, run.createTx)} target="_blank" rel="noreferrer">view transaction</a>
              </>
            )}
          </p>
        ) : (
          <button className="btn mt-3" onClick={() => void create()} disabled={busy !== null}>
            {busy === "create" ? "Confirm in your wallet…" : "Create run from my wallet"}
          </button>
        )}
      </Step>

      <Step title={`Approve (${approvals.length} of ${run.org.threshold} needed)`} state={!chain ? "later" : status === "draft" ? "now" : "done"}>
        <ul className="space-y-1.5 text-sm">
          {run.org.approvers.map((a) => (
            <li key={a} className="flex items-center gap-2">
              <span className={approvals.includes(a) ? "text-accent" : "text-muted"}>{approvals.includes(a) ? "✓" : "○"}</span>
              <span className="num">{a}</span>
              {a === accountId && <span className="text-xs text-muted">(you)</span>}
            </li>
          ))}
        </ul>
        {chain && status === "draft" && (
          <>
            {!iApproved && (
              <button className="btn mt-3" onClick={() => void approve()} disabled={busy !== null}>
                {busy === "approve" ? "Confirm in your wallet…" : "Approve from my wallet"}
              </button>
            )}
            {run.org.approvers.filter((a) => !approvals.includes(a) && a !== accountId).map((a) => (
              <Cli key={a} label={`${a} approves from the NEAR CLI:`} command={cliApprove(a)} />
            ))}
          </>
        )}
      </Step>

      <Step title="Fund with USDC" state={!chain || status === "draft" ? "later" : status === "approved" ? "now" : "done"}>
        {chain && (
          <p className="num text-sm">
            {formatUsdc(chain.funded_amount)} of {formatUsdc(chain.total_amount)} USDC funded
          </p>
        )}
        {chain && status === "approved" && (
          <>
            <p className="mt-1 text-sm leading-6 text-muted">
              Send {formatUsdc(remaining)} USDC to the contract with the run key in the message. Extra funds are returned by the contract.
              {run.network !== "mainnet" && " On testnet this is the test token, not real USDC."}
            </p>
            <Cli label={`${run.org.refundAccount} (treasury) funds from the NEAR CLI:`} command={cliFund(run.org.refundAccount)} />
            <button className="btn-quiet mt-3" onClick={() => void fund()} disabled={busy !== null}>
              {busy === "fund" ? "Confirm in your wallet…" : "Or fund from my wallet (needs a USDC balance)"}
            </button>
          </>
        )}
        {status === "active" && (
          <p className="mt-2 text-sm leading-6">
            Fully funded. Claims are open until {new Date(chain!.claim_deadline_ms).toLocaleString()}. Share the claim link:{" "}
            <span className="num break-all">{typeof window === "undefined" ? "" : window.location.origin}/claim/{run.runKey}</span>
            <span className="block text-xs text-muted">The claim page is the next thing being built; the link will not open yet.</span>
          </p>
        )}
      </Step>

      <div className="flex items-center gap-3">
        <button className="btn-quiet" onClick={() => void act("sync", async () => null)} disabled={busy !== null}>
          {busy === "sync" ? "Reading the contract…" : "Refresh on-chain status"}
        </button>
        <span className="text-xs text-muted">{waiting ? "The page also re-reads the contract every 5 seconds while it waits for approvals or funds." : "Reads the run from the contract."}</span>
      </div>
    </div>
  );
}

function Step({ title, state, children }: { title: string; state: "done" | "now" | "later"; children: React.ReactNode }) {
  return (
    <div className={`card p-5 ${state === "now" ? "border-ink" : ""} ${state === "later" ? "opacity-60" : ""}`}>
      <p className="flex items-center gap-2 font-medium">
        <span className={state === "done" ? "text-accent" : "text-muted"}>{state === "done" ? "✓" : state === "now" ? "→" : "·"}</span>
        {title}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Cli({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 flex items-start gap-2">
        <pre className="num flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-paper p-3 text-xs">{command}</pre>
        <button
          className="btn-quiet shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
