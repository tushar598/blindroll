"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { viewContract } from "@/lib/client/chain";
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

/** Copyable NEAR CLI commands are a local-development aid only; a production build never shows them (docs/12). */
const SHOW_CLI = process.env.NODE_ENV === "development";

/** create_run → approve_run (threshold) → fund. Each step is a real transaction from the signed-in approver's wallet. */
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

  // Other approvers act from their own browser, so the page re-reads the contract by itself every few
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

  // The signed-in approver's token balance, read by the browser from a public RPC while funding is due.
  const [balance, setBalance] = useState<string | null>(null);
  const needsFunds = chain?.status.toLowerCase() === "approved";
  const { network, tokenId } = run;
  const loadBalance = useCallback(
    () =>
      viewContract<string>(network, tokenId, "ft_balance_of", { account_id: accountId })
        .then((b) => setBalance(b.value))
        .catch(() => setBalance(null)),
    [network, tokenId, accountId],
  );
  useEffect(() => {
    if (needsFunds) void loadBalance();
  }, [needsFunds, loadBalance]);

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
      return (await callContract(run.network, { signerId: accountId, receiverId: c.contractId, methodName: "create_run", args: c.args, gasTgas: 30, depositYocto: c.depositYocto })).txHash;
    }, true);
  const approve = () =>
    act("approve", async () => (await callContract(run.network, { signerId: accountId, receiverId: run.contractId, methodName: "approve_run", args: { run_key: run.runKey }, gasTgas: 30, depositYocto: "0" })).txHash);
  const fund = () =>
    act("fund", async () => {
      const remaining = (BigInt(chain!.total_amount) - BigInt(chain!.funded_amount)).toString();
      return (
        await callContract(run.network, {
          signerId: accountId,
          receiverId: run.tokenId,
          methodName: "ft_transfer_call",
          args: { receiver_id: run.contractId, amount: remaining, msg: JSON.stringify({ fund_run: run.runKey }) },
          gasTgas: 100,
          depositYocto: "1",
        })
      ).txHash;
    });

  /** TESTNET ONLY: mints the missing test USDC to the signed-in approver (the mock token has an open mint). */
  const mintTestUsdc = () =>
    act("mint", async () => {
      if (run.network === "mainnet") throw new Error("Test USDC does not exist on mainnet");
      const missing = BigInt(chain!.total_amount) - BigInt(chain!.funded_amount) - BigInt(balance ?? "0");
      const tx = (
        await callContract(run.network, {
          signerId: accountId,
          receiverId: run.tokenId,
          methodName: "mint",
          args: { account_id: accountId, amount: (missing > 0n ? missing : 1_000_000n).toString() },
          gasTgas: 30,
          depositYocto: "0",
        })
      ).txHash;
      await loadBalance();
      return tx;
    });

  const approvals = chain?.approvals ?? [];
  // Once the run is on-chain, its approvers are the ones stored in the contract.
  const approverList = chain?.approvers ?? run.org.approvers;
  const threshold = chain?.threshold ?? run.org.threshold;
  const iApproved = approvals.includes(accountId);
  const status = chain?.status.toLowerCase() ?? "not_created";
  const remaining = chain ? (BigInt(chain.total_amount) - BigInt(chain.funded_amount)).toString() : fin.totalAmount;
  const cliApprove = (who: string) =>
    `near contract call-function as-transaction ${run.contractId} approve_run json-args '{"run_key":"${run.runKey}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${who} ${net} sign-with-keychain send`;
  const cliFund = (who: string) =>
    `near contract call-function as-transaction ${run.tokenId} ft_transfer_call json-args '{"receiver_id":"${run.contractId}","amount":"${remaining}","msg":"{\\"fund_run\\":\\"${run.runKey}\\"}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${who} ${net} sign-with-keychain send`;

  return (
    <div className="space-y-4 font-mono">
      {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f]">{error}</p>}
      {lastTx && (
        <p className="border border-[#0667DC]/30 bg-[#e8f1fc] px-3 py-2 text-sm text-[#0667DC]">
          Transaction sent:{" "}
          <a className="num underline" href={explorerTx(run.network, lastTx)} target="_blank" rel="noreferrer">{lastTx}</a>
        </p>
      )}

      <Step title="Create the run on-chain" state={chain ? "done" : "now"}>
        <p className="text-sm leading-6 text-[#322E25]/70">
          Stores the Merkle root, the report hash, the approvers and the deadline in{" "}
          <a className="num underline text-[#0667DC]" href={explorerAccount(run.network, run.contractId)} target="_blank" rel="noreferrer">{run.contractId}</a>. No row data goes on-chain.
          You pay a small storage deposit; the contract refunds what it does not use.
        </p>
        {chain ? (
          <p className="mt-2 text-sm">
            Created by <span className="num font-semibold text-[#322E25]">{chain.creator}</span>
            {run.createTx && (
              <>
                {" · "}
                <a className="text-[#0667DC] underline" href={explorerTx(run.network, run.createTx)} target="_blank" rel="noreferrer">view transaction</a>
              </>
            )}
          </p>
        ) : (
          <button className="btn mt-3" onClick={() => void create()} disabled={busy !== null}>
            {busy === "create" ? "Confirm in your wallet…" : "Create run from my wallet"}
          </button>
        )}
      </Step>

      <Step title={`Approve (${approvals.length} of ${threshold} needed)`} state={!chain ? "later" : status === "draft" ? "now" : "done"}>
        <ul className="space-y-1.5 text-sm">
          {approverList.map((a) => (
            <li key={a} className="flex items-center gap-2">
              <span className={approvals.includes(a) ? "text-[#0667DC] font-bold" : "text-[#322E25]/40"}>{approvals.includes(a) ? "✓" : "○"}</span>
              <span className="num">{a}</span>
              {a === accountId && <span className="text-xs text-[#322E25]/60">(you)</span>}
            </li>
          ))}
        </ul>
        {chain && status === "draft" && (
          <>
            {!iApproved && approverList.includes(accountId) && (
              <button className="btn mt-3" onClick={() => void approve()} disabled={busy !== null}>
                {busy === "approve" ? "Confirm in your wallet…" : "Approve from my wallet"}
              </button>
            )}
            {!approverList.includes(accountId) && <p className="mt-3 text-sm text-[#322E25]/60">Your account is not an approver of this run on the contract.</p>}
            {iApproved && approvals.length < threshold && (
              <p className="mt-3 text-sm leading-6 text-[#322E25]/70">
                Waiting for another approver. They open this page, sign in with their own wallet and press Approve. This page updates by itself.
              </p>
            )}
            {SHOW_CLI &&
              approverList.filter((a) => !approvals.includes(a) && a !== accountId).map((a) => (
                <Cli key={a} label={`Development only: ${a} approves from the NEAR CLI:`} command={cliApprove(a)} />
              ))}
          </>
        )}
      </Step>

      <Step title="Fund with USDC" state={!chain || status === "draft" ? "later" : status === "approved" ? "now" : "done"}>
        {chain && (
          <p className="num text-sm font-semibold">
            {formatUsdc(chain.funded_amount)} of {formatUsdc(chain.total_amount)} USDC funded
          </p>
        )}
        {chain && status === "approved" && (
          <>
            <p className="mt-1 text-sm leading-6 text-[#322E25]/70">
              Send {formatUsdc(remaining)} USDC to the contract with the run key in the message. Extra funds are returned by the contract.
              {run.network !== "mainnet" && " On testnet this is the test token, not real USDC."}
            </p>
            <p className="mt-3 text-sm">
              Your wallet <span className="num font-semibold">{accountId}</span> holds{" "}
              <span className="num font-semibold">{balance === null ? "…" : formatUsdc(balance)} USDC</span>
              {run.network !== "mainnet" && " (test token)"}.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button className="btn" onClick={() => void fund()} disabled={busy !== null || balance === null || BigInt(balance) < BigInt(remaining)}>
                {busy === "fund" ? "Confirm in your wallet…" : `Fund ${formatUsdc(remaining)} USDC from my wallet`}
              </button>
              {run.network !== "mainnet" && (
                <button className="btn-quiet" onClick={() => void mintTestUsdc()} disabled={busy !== null || balance === null}>
                  {busy === "mint" ? "Confirm in your wallet…" : "Get test USDC"}
                </button>
              )}
            </div>
            {balance !== null && BigInt(balance) < BigInt(remaining) && (
              <p className="mt-2 text-xs text-[#8a5a00]">
                {run.network !== "mainnet"
                  ? "Not enough test USDC in this wallet yet. “Get test USDC” mints the missing amount of the test token to your wallet; it has no real value."
                  : "This wallet does not hold enough USDC to fund the run."}
              </p>
            )}
            {SHOW_CLI && <Cli label={`Development only: ${run.org.refundAccount} (treasury) funds from the NEAR CLI:`} command={cliFund(run.org.refundAccount)} />}
          </>
        )}
        {status === "active" && (
          <p className="mt-2 text-sm leading-6">
            Fully funded. Claims are open until {new Date(chain!.claim_deadline_ms).toLocaleString()}. Share the claim link:{" "}
            <span className="num break-all font-semibold text-[#0667DC]">{typeof window === "undefined" ? "" : window.location.origin}/claim/{run.runKey}</span>
            <span className="block text-xs text-[#322E25]/60 mt-1">The link shows nothing by itself: each recipient must sign with their own wallet to see their row.</span>
          </p>
        )}
      </Step>

      <div className="flex items-center gap-3 pt-2">
        <button className="btn-quiet text-xs" onClick={() => void act("sync", async () => null)} disabled={busy !== null}>
          {busy === "sync" ? "Reading the contract…" : "Refresh on-chain status"}
        </button>
        <span className="text-xs text-[#322E25]/60">{waiting ? "The page also re-reads the contract every 5 seconds while it waits for approvals or funds." : "Reads the run from the contract."}</span>
      </div>
    </div>
  );
}

function Step({ title, state, children }: { title: string; state: "done" | "now" | "later"; children: React.ReactNode }) {
  const stateCls =
    state === "done"
      ? "border border-[#0667DC]/30 bg-[#e8f1fc]"
      : state === "now"
      ? "border-2 border-[#322E25] bg-[#E1D7C0]/60"
      : "border border-[#322E25]/15 bg-[#E1D7C0]/60 opacity-60";

  return (
    <div className={`p-5 ${stateCls}`}>
      <p className="flex items-center gap-2 font-bold text-sm uppercase tracking-wide">
        <span className={state === "done" ? "text-[#0667DC]" : state === "now" ? "text-[#322E25]" : "text-[#322E25]/40"}>
          {state === "done" ? "✓" : state === "now" ? "→" : "·"}
        </span>
        {title}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Cli({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <p className="text-xs text-[#322E25]/60">{label}</p>
      <div className="mt-1 flex items-start gap-2">
        <pre className="num flex-1 overflow-x-auto whitespace-pre-wrap break-all border border-[#322E25]/20 bg-[#E9E1CD] p-3 text-xs">{command}</pre>
        <button
          className="btn-quiet shrink-0 text-xs"
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
