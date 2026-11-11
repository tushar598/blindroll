"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { buildViewMessage } from "@blindroll/core";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { type EvmWallet, connectEvm, discoverEvmWallets, personalSign } from "@/lib/client/evm";
import { callContract, connectWallet, explorerTx, signInMessage } from "@/lib/client/wallet";
import { SimulatedBadge } from "./payouts-panel";

interface RunInfo {
  runKey: string;
  runName: string;
  orgName: string;
  status: string;
  claimDeadlineMs: number;
  network: string;
  contractId: string;
  tokenId: string;
}
interface ClaimInfo {
  status: string;
  optionId: string;
  payoutTarget: string;
  txHash: string | null;
  error: string | null;
  simulated: boolean;
  payoutStatus: string | null;
  refundTx: string | null;
}
interface Row {
  chain: "evm" | "near";
  address: string;
  amount: string;
  amountDisplay: string;
  name: string;
  memo: string;
  role: string;
  claimed: boolean;
  claim: ClaimInfo | null;
}
interface Option {
  id: string;
  rail: string;
  label: string;
  symbol: string;
  decimals: number;
  estimatedAmountOut: string;
  estimatedMinAmountOut?: string;
  feeBps?: number;
  etaSeconds?: number;
  estimated: boolean;
  simulated: boolean;
  available: boolean;
  unavailableReason?: string;
  note?: string;
}
interface Summary {
  label: string;
  receiver: string;
  amountDisplay: string;
  simulated: boolean;
  note?: string;
  estimatedAmountOut?: string;
  estimatedMinAmountOut?: string | null;
  symbol?: string;
  decimals?: number;
  holdingAccount?: string;
}
type Prepared =
  | { kind: "evm"; claimId: number; message: string; expiresAtMs: number; summary: Summary }
  | { kind: "near"; claimId: number; summary: Summary; call: { contractId: string; methodName: string; args: object; gasTgas: number; depositYocto: string } };

type Signer = { chain: "evm"; wallet: EvmWallet; address: string } | { chain: "near"; address: string };

function formatUnits(base: string, decimals: number): string {
  const n = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const frac = (n % d).toString().padStart(decimals, "0").slice(0, 2);
  return `${(n / d).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

export function ClaimScreen() {
  const { runKey } = useParams<{ runKey: string }>();
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** When the run info arrived; the deadline is compared against this (the server re-checks at claim time). */
  const [loadedAt, setLoadedAt] = useState(0);
  const [evmWallets, setEvmWallets] = useState<EvmWallet[] | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [row, setRow] = useState<Row | null>(null);
  const [notListed, setNotListed] = useState(false);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [receiver, setReceiver] = useState("");
  const [optionId, setOptionId] = useState("near-usdc");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<RunInfo>(`/api/claim/${runKey}`)
      .then((r) => {
        if (!live) return;
        setInfo(r);
        setLoadedAt(Date.now());
      })
      .catch((err) => live && setLoadError(errorMessage(err)));
    discoverEvmWallets().then((w) => live && setEvmWallets(w));
    return () => {
      live = false;
    };
  }, [runKey]);

  async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  /** Connect → sign the view message (no gas) → the server returns only this wallet's row. */
  async function connectAndView(kind: { chain: "evm"; wallet: EvmWallet } | { chain: "near" }) {
    if (!info) return;
    setNotListed(false);
    await run("view", async () => {
      const s: Signer =
        kind.chain === "evm"
          ? { chain: "evm", wallet: kind.wallet, address: await connectEvm(kind.wallet) }
          : { chain: "near", address: await connectWallet(info.network, info.contractId) };
      setSigner(s);
      const c = await api<{ nonce: string; issued: string; recipient: string }>(`/api/claim/${runKey}/challenge`);
      const message = buildViewMessage({ runKey, address: s.address, nonce: c.nonce, issued: c.issued });
      let body: Record<string, string>;
      if (s.chain === "evm") {
        body = { chain: "evm", address: s.address, nonce: c.nonce, issued: c.issued, signature: await personalSign(s.wallet, s.address, message) };
      } else {
        const signed = await signInMessage(info.network, { message, recipient: c.recipient, nonceBase64: c.nonce });
        body = { chain: "near", address: s.address, nonce: c.nonce, issued: c.issued, signature: signed.signature, publicKey: signed.publicKey };
      }
      try {
        const r = await api<{ row: Row; token: string }>(`/api/claim/${runKey}/view`, { json: body });
        setRow(r.row);
        setToken(r.token);
        if (s.chain === "near") setReceiver(s.address);
        if (!r.row.claimed) setOptions((await api<{ options: Option[] }>(`/api/claim/${runKey}/options`, { token: r.token })).options);
      } catch (err) {
        if (err instanceof ApiError && err.code === "not_listed") setNotListed(true);
        else throw err;
      }
    });
  }

  async function prepare() {
    if (!token) return;
    const p = await run("prepare", () => api<Prepared>(`/api/claim/${runKey}/prepare`, { token, json: optionId === "near-usdc" ? { optionId, receiver } : { optionId } }));
    if (p) setPrepared(p);
  }

  async function signAndSubmit() {
    if (!token || !prepared || !signer || !info) return;
    await run("submit", async () => {
      if (prepared.kind === "evm" && signer.chain === "evm") {
        const signature = await personalSign(signer.wallet, signer.address, prepared.message);
        await api(`/api/claim/${runKey}/submit`, { token, json: { claimId: prepared.claimId, signature } });
      } else if (prepared.kind === "near") {
        const { txHash } = await callContract(info.network, { receiverId: prepared.call.contractId, methodName: prepared.call.methodName, args: prepared.call.args, gasTgas: prepared.call.gasTgas, depositYocto: prepared.call.depositYocto });
        await api(`/api/claim/${runKey}/submit`, { token, json: { claimId: prepared.claimId, txHash } });
      }
      setPrepared(null);
      setRow(await api<Row>(`/api/claim/${runKey}/status`, { token }));
    });
    // A failed submit still changes the status shown.
    if (token) api<Row>(`/api/claim/${runKey}/status`, { token }).then(setRow).catch(() => undefined);
  }

  if (loadError) return <p className="mx-auto max-w-xl rounded-md bg-error-soft px-3 py-2 text-sm text-error">{loadError}</p>;
  if (!info) return <p className="text-sm text-muted">Loading…</p>;

  const deadlinePassed = loadedAt > info.claimDeadlineMs;
  const open = info.status === "active" && !deadlinePassed;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="label">{info.orgName}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{info.runName}</h1>
        <p className="mt-2 text-sm text-muted">
          {open ? `Claims are open until ${new Date(info.claimDeadlineMs).toLocaleString()}.` : deadlinePassed ? "The claim deadline has passed." : `Claims are not open (the run is ${info.status}).`}
          {info.network !== "mainnet" && " This is a testnet run: the token is test USDC with no real value."}
        </p>
      </div>
      {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}

      {!row && (
        <div className="card p-6">
          <p className="font-medium">See your payout</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            Connect the wallet you were paid at and sign a short message. It proves the address is yours; it is not a transaction and costs no gas.
            You will see only your own row.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {evmWallets?.map((w) => (
              <button key={w.id} className="btn" disabled={busy !== null} onClick={() => void connectAndView({ chain: "evm", wallet: w })}>
                {busy === "view" ? "Check your wallet…" : `${w.name} (EVM)`}
              </button>
            ))}
            <button className="btn-quiet" disabled={busy !== null} onClick={() => void connectAndView({ chain: "near" })}>
              Meteor wallet (NEAR)
            </button>
          </div>
          {evmWallets?.length === 0 && <p className="mt-3 text-sm text-muted">No EVM wallet extension was found in this browser. Install MetaMask to claim with an EVM address.</p>}
          {notListed && signer && (
            <p className="mt-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
              This wallet isn&apos;t in this payroll run. <span className="num">{signer.address}</span>
            </p>
          )}
        </div>
      )}

      {row && (
        <div className="card p-6">
          <p className="label">Your payout</p>
          <p className="num mt-1 text-4xl">{row.amountDisplay} <span className="text-xl text-muted">USDC</span></p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="label">Wallet</dt>
              <dd className="num mt-0.5 break-all text-xs">{row.address}</dd>
            </div>
            {(row.name || row.memo) && (
              <div>
                <dt className="label">For</dt>
                <dd className="mt-0.5">{[row.name, row.role, row.memo].filter(Boolean).join(" · ")}</dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-xs leading-5 text-muted">
            Only you see this row. Claiming is a standard on-chain transfer: it makes this address and amount public.
          </p>
        </div>
      )}

      {row?.claimed && (
        <div className="card border-accent p-6">
          <p className="flex items-center gap-2 font-medium text-accent">
            ✓ Claimed {row.claim?.simulated && <SimulatedBadge />}
          </p>
          {!row.claim && <p className="mt-1 text-sm">The contract shows this payout as claimed.</p>}
          {row.claim && !row.claim.simulated && (
            <p className="mt-1 text-sm leading-6">
              {row.amountDisplay} USDC was sent to <span className="num">{row.claim.payoutTarget}</span>.
            </p>
          )}
          {row.claim?.simulated && (
            <div className="mt-1 space-y-2 text-sm leading-6">
              <p>
                {row.claim.payoutStatus === "refunded_simulated"
                  ? "Refunded (simulated failure). The team has been notified; once they reopen your claim you can claim again here."
                  : "Delivered (simulated)."}
              </p>
              <p className="text-muted">
                This is a testnet simulation: nothing arrived on the destination chain, because cross-chain delivery (1Click) only exists on mainnet.
                The contract really paid {row.amountDisplay} test USDC to the holding account <span className="num">{row.claim.payoutTarget}</span>.
              </p>
            </div>
          )}
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
            {row.claim?.txHash && <a className="underline" href={explorerTx(info.network, row.claim.txHash)} target="_blank" rel="noreferrer">View the claim transaction</a>}
            {row.claim?.refundTx && <a className="underline" href={explorerTx(info.network, row.claim.refundTx)} target="_blank" rel="noreferrer">View the refund transaction</a>}
          </p>
        </div>
      )}

      {row && !row.claimed && row.claim?.payoutStatus === "reopened" && (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
          Your earlier (simulated) payout was refunded and your claim was reopened. You can claim again below.
        </p>
      )}

      {row && !row.claimed && row.claim?.status === "failed" && row.claim.payoutStatus !== "reopened" && (
        <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          The last claim attempt did not go through{row.claim.error ? `: ${row.claim.error}` : ""}. Nothing was paid; you can try again.
        </p>
      )}

      {row && !row.claimed && open && !prepared && (
        <div className="card p-6">
          <p className="font-medium">Choose how to receive it</p>
          <p className="mt-1 text-sm text-muted">The amount owed is fixed in USDC. You choose only where it goes.</p>
          <div className="mt-4 divide-y divide-line rounded-md border border-line">
            {options === null && <p className="p-4 text-sm text-muted">Loading options…</p>}
            {options?.map((o) => (
              <label key={o.id} className={`flex gap-3 p-4 ${o.available ? "cursor-pointer" : "opacity-70"} ${optionId === o.id ? "bg-accent-soft/60" : ""}`}>
                <input type="radio" name="payout-option" className="mt-1 accent-[var(--accent)]" disabled={!o.available} checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="flex items-center gap-2 font-medium">
                      {o.label}
                      {o.simulated && <SimulatedBadge />}
                    </p>
                    <p className="num text-sm">
                      {o.estimated ? "~" : ""}
                      {formatUnits(o.estimatedAmountOut, o.decimals)} {o.symbol}
                      {o.estimated && <span className="ml-1 text-xs text-muted">estimated</span>}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {o.feeBps !== undefined && `Fee ~${(o.feeBps / 100).toFixed(2)}% · `}
                    {o.etaSeconds !== undefined && `about ${o.etaSeconds < 60 ? `${o.etaSeconds} s` : `${Math.round(o.etaSeconds / 60)} min`}`}
                    {o.estimatedMinAmountOut && ` · at least ${formatUnits(o.estimatedMinAmountOut, o.decimals)} ${o.symbol} after slippage`}
                  </p>
                  {o.note && <p className="mt-1 text-xs text-warn">{o.note}</p>}
                  {!o.available && o.unavailableReason && <p className="mt-1 text-xs text-warn">{o.unavailableReason}</p>}
                </div>
              </label>
            ))}
          </div>

          {optionId !== "near-usdc" && (
            <div className="mt-5">
              <p className="text-sm leading-6">
                Destination: your own address <span className="num break-all">{row.address}</span>.
              </p>
              <p className="mt-1 text-xs leading-5 text-warn">
                Simulated on testnet: you will sign a real claim and the contract will really pay out, but to a holding account. Nothing will arrive at this address.
              </p>
              <button className="btn mt-4" disabled={busy !== null} onClick={() => void prepare()}>
                {busy === "prepare" ? "Checking…" : "Continue"}
              </button>
            </div>
          )}
          <div className={`mt-5 ${optionId === "near-usdc" ? "" : "hidden"}`}>
            <label className="label" htmlFor="receiver">NEAR account to receive the USDC</label>
            <input id="receiver" className="field num mt-1" value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder={info.network === "mainnet" ? "you.near" : "you.testnet"} autoComplete="off" spellCheck={false} />
            <p className="mt-1.5 text-xs leading-5 text-muted">
              {row.chain === "evm"
                ? "It goes into the message you sign, so nobody (including our relayer) can send your payout anywhere else. The relayer pays the gas."
                : "You send the claim from your own NEAR wallet and pay a very small gas fee."}
            </p>
            <button className="btn mt-4" disabled={busy !== null || receiver.trim() === ""} onClick={() => void prepare()}>
              {busy === "prepare" ? "Checking…" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {row && !row.claimed && prepared && (
        <div className="card border-ink p-6">
          <p className="font-medium">Review and sign</p>
          {prepared.summary.simulated ? (
            <div className="mt-1 space-y-2 text-sm leading-6">
              <p className="flex flex-wrap items-center gap-2">
                <span className="num">{prepared.summary.amountDisplay} USDC</span> as {prepared.summary.label} to <span className="num break-all">{prepared.summary.receiver}</span> <SimulatedBadge />
              </p>
              {prepared.summary.estimatedAmountOut && prepared.summary.decimals !== undefined && (
                <p className="text-muted">
                  Estimate from mainnet prices: ~{formatUnits(prepared.summary.estimatedAmountOut, prepared.summary.decimals)} {prepared.summary.symbol}
                  {prepared.summary.estimatedMinAmountOut && `, at least ${formatUnits(prepared.summary.estimatedMinAmountOut, prepared.summary.decimals)} after slippage`}.
                </p>
              )}
              <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">
                {prepared.summary.note} Holding account: <span className="num">{prepared.summary.holdingAccount}</span>.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-sm leading-6">
              <span className="num">{prepared.summary.amountDisplay} USDC</span> on NEAR to <span className="num">{prepared.summary.receiver}</span>.
            </p>
          )}
          {prepared.kind === "evm" ? (
            <>
              <p className="label mt-4">Message your wallet will show</p>
              <pre className="num mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-paper p-3 text-xs">{prepared.message}</pre>
              <p className="mt-2 text-xs text-muted">Sign within 10 minutes (expires {new Date(prepared.expiresAtMs).toLocaleTimeString()}). Signing costs nothing.</p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted">Your NEAR wallet will ask you to approve a call to <span className="num">{prepared.call.contractId}</span>.</p>
          )}
          <div className="mt-4 flex gap-3">
            <button className="btn" disabled={busy !== null} onClick={() => void signAndSubmit()}>
              {busy === "submit" ? "Signing and sending…" : prepared.kind === "evm" ? "Sign and claim" : "Claim from my wallet"}
            </button>
            <button className="btn-quiet" disabled={busy !== null} onClick={() => setPrepared(null)}>Back</button>
          </div>
        </div>
      )}

      {row && !row.claimed && !open && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">This run is not accepting claims right now.</p>}
    </div>
  );
}
