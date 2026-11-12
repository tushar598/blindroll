"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { buildViewMessage } from "@blindroll/core";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { type EvmWallet, connectEvm, discoverEvmWallets, personalSign } from "@/lib/client/evm";
import { callContract, configureWallets, connectWallet, currentWalletAccount, disconnectWallet, explorerTx, isPopupBlockedError, isWalletAccountError, signInMessage } from "@/lib/client/wallet";
import { NearWalletChoice, useNearWalletChoice } from "./near-wallet-choice";
import { CrossChainSimNotice, RealBadge, TrustNotice } from "./notices";
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
  /** NEAR wallet IDs this deployment offers (Meteor always). */
  wallets?: string[];
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
  // relayed: the relayer submits the claim and pays the gas (USDC on NEAR to the recipient's own account).
  | { kind: "near"; claimId: number; summary: Summary; relayed: true; call: null }
  | { kind: "near"; claimId: number; summary: Summary; relayed: false; call: { contractId: string; methodName: string; args: object; gasTgas: number; depositYocto: string } };

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
  const nearWallet = useNearWalletChoice(info?.network);
  /** The NEAR account the chosen wallet remembers for this site (it may be left over from another page). */
  const [rememberedNear, setRememberedNear] = useState<string | null>(null);
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
        configureWallets(r.wallets);
        setInfo(r);
        setLoadedAt(Date.now());
        return currentWalletAccount(r.network).then((a) => live && setRememberedNear(a));
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
  async function connectAndView(kind: { chain: "evm"; wallet: EvmWallet } | { chain: "near"; fresh?: boolean }) {
    if (!info) return;
    setNotListed(false);
    setBusy("view");
    setError(null);
    try {
      await view(kind);
    } catch (err) {
      if (kind.chain === "near" && isPopupBlockedError(err)) {
        // Web wallets: the connect popup used up this click; "Continue as this account" signs with a new one.
        setError(`${nearWallet.label} is connected. Press "Continue as this account" to sign the view message (your browser blocked the second popup).`);
      } else if (kind.chain === "near" && isWalletAccountError(err)) {
        // The wallet no longer has the remembered account (e.g. another account is active in the wallet).
        await disconnectWallet(info.network);
        setRememberedNear(null);
        setSigner(null);
        setError(`${nearWallet.label} could not use the remembered account, so it was disconnected. Connect again and choose the account you were paid at.`);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(null);
      if (kind.chain === "near") setRememberedNear(await currentWalletAccount(info.network));
    }
  }

  /** Forget this wallet's row and go back to the connect step. */
  function resetView() {
    setSigner(null);
    setToken(null);
    setRow(null);
    setOptions(null);
    setPrepared(null);
    setNotListed(false);
    setReceiver("");
    setOptionId("near-usdc");
    setError(null);
  }

  /** NEAR only: disconnect the wallet, then connect again so it asks which account to use. */
  async function switchNearAccount() {
    resetView();
    await connectAndView({ chain: "near", fresh: true });
  }

  async function view(kind: { chain: "evm"; wallet: EvmWallet } | { chain: "near"; fresh?: boolean }) {
    if (!info) return;
    {
      const s: Signer =
        kind.chain === "evm"
          ? { chain: "evm", wallet: kind.wallet, address: await connectEvm(kind.wallet) }
          : { chain: "near", address: await connectWallet(info.network, info.contractId, { fresh: kind.fresh }) };
      setSigner(s);
      const c = await api<{ nonce: string; issued: string; recipient: string }>(`/api/claim/${runKey}/challenge`);
      const message = buildViewMessage({ runKey, address: s.address, nonce: c.nonce, issued: c.issued });
      let body: Record<string, string>;
      if (s.chain === "evm") {
        body = { chain: "evm", address: s.address, nonce: c.nonce, issued: c.issued, signature: await personalSign(s.wallet, s.address, message) };
      } else {
        const signed = await signInMessage(info.network, { message, recipient: c.recipient, nonceBase64: c.nonce });
        body = {
          chain: "near", address: s.address, nonce: c.nonce, issued: c.issued, signature: signed.signature, publicKey: signed.publicKey,
          ...("callbackUrl" in signed && signed.callbackUrl ? { callbackUrl: signed.callbackUrl } : {}),
        };
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
    }
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
      } else if (prepared.kind === "near" && prepared.relayed) {
        await api(`/api/claim/${runKey}/submit`, { token, json: { claimId: prepared.claimId } });
      } else if (prepared.kind === "near") {
        const { txHash } = await callContract(info.network, { signerId: signer.address, receiverId: prepared.call.contractId, methodName: prepared.call.methodName, args: prepared.call.args, gasTgas: prepared.call.gasTgas, depositYocto: prepared.call.depositYocto });
        await api(`/api/claim/${runKey}/submit`, { token, json: { claimId: prepared.claimId, txHash } });
      }
      setPrepared(null);
      setRow(await api<Row>(`/api/claim/${runKey}/status`, { token }));
    });
    // A failed submit still changes the status shown.
    if (token) api<Row>(`/api/claim/${runKey}/status`, { token }).then(setRow).catch(() => undefined);
  }

  if (loadError) return <p className="mx-auto max-w-xl border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{loadError}</p>;
  if (!info) return <p className="text-sm font-mono text-[#322E25]/70">Loading…</p>;

  const deadlinePassed = loadedAt > info.claimDeadlineMs;
  const open = info.status === "active" && !deadlinePassed;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">{info.orgName}</p>
        <h1 className="mt-1 text-2xl font-bold uppercase tracking-tight">{info.runName}</h1>
        <p className="text-sm font-mono text-[#322E25]/70 leading-6 mt-2">
          {open ? `Claims are open until ${new Date(info.claimDeadlineMs).toLocaleString()}.` : deadlinePassed ? "The claim deadline has passed." : `Claims are not open (the run is ${info.status}).`}
          {info.network !== "mainnet" && " This is a testnet run: the token is test USDC with no real value."}
        </p>
      </div>
      <ClaimSteps current={!row ? 2 : row.claimed ? 4 : 3} />
      <TrustNotice />
      {info.network !== "mainnet" && (options?.some((o) => o.rail === "oneclick") || row?.claim?.simulated) && <CrossChainSimNotice />}
      {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{error}</p>}

      {!row && (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
          <p className="font-bold font-mono uppercase tracking-tight">Connect your wallet</p>
          <p className="mt-1 text-sm font-mono text-[#322E25]/70 leading-6">
            Use the wallet you are paid at and sign one message. No transaction, no gas. You see only your own row.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {evmWallets?.map((w) => (
              <button key={w.id} className="btn" disabled={busy !== null} onClick={() => void connectAndView({ chain: "evm", wallet: w })}>
                {busy === "view" ? "Check your wallet…" : `${w.name} (EVM)`}
              </button>
            ))}
            {!rememberedNear && (
              <button className="btn-quiet" disabled={busy !== null} onClick={() => void connectAndView({ chain: "near" })}>
                {nearWallet.label} wallet (NEAR)
              </button>
            )}
          </div>
          <div className="mt-3">
            <NearWalletChoice choice={nearWallet} disabled={busy !== null} onChange={() => void currentWalletAccount(info.network).then(setRememberedNear)} />
          </div>
          {rememberedNear && (
            <div className="mt-4 border border-[#322E25]/15 p-4 text-sm font-mono">
              <p>
                {nearWallet.label} wallet (NEAR) is connected as <span className="break-all text-xs font-mono">{rememberedNear}</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button className="btn-quiet" disabled={busy !== null} onClick={() => void connectAndView({ chain: "near" })}>
                  Continue as this account
                </button>
                <button className="btn-quiet" disabled={busy !== null} onClick={() => void switchNearAccount()}>
                  Switch account
                </button>
              </div>
            </div>
          )}
          {evmWallets?.length === 0 && <p className="mt-3 text-sm font-mono text-[#322E25]/70">No EVM wallet extension was found in this browser. Install MetaMask to claim with an EVM address.</p>}
          {notListed && signer && (
            <p className="mt-4 border border-[#8a5a00]/40 bg-[#fbf0d6] px-3 py-2 text-sm font-mono text-[#8a5a00]">
              This wallet isn&apos;t in this payroll run. <span className="font-mono break-all">{signer.address}</span>
              {signer.chain === "evm" && " To use another address, switch accounts in your wallet extension and connect again."}
            </p>
          )}
        </div>
      )}

      {row && (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">Your payout</p>
          <p className="mt-1">
            <span className="text-4xl font-mono font-bold tabular-nums">{row.amountDisplay}</span>{" "}
            <span className="text-xl font-mono text-[#322E25]/60">USDC</span>
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">Connected as</dt>
              <dd className="text-xs font-mono break-all mt-0.5">{row.address}</dd>
              <dd className="mt-1.5">
                <button className="text-xs font-mono underline disabled:opacity-50" disabled={busy !== null} onClick={() => (signer?.chain === "near" ? void switchNearAccount() : resetView())}>
                  {signer?.chain === "near" ? "Switch account" : "Use a different wallet"}
                </button>
              </dd>
            </div>
            {(row.name || row.memo) && (
              <div>
                <dt className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">For</dt>
                <dd className="text-xs font-mono mt-0.5">{[row.name, row.role, row.memo].filter(Boolean).join(" · ")}</dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-xs font-mono leading-5 text-[#322E25]/70">
            Only you see this row. Claiming is a standard on-chain transfer: it makes this address and amount public.
          </p>
        </div>
      )}

      {row?.claimed && (
        <div className="border-2 border-[#0667DC] bg-[#E1D7C0]/60 p-6">
          <p className="flex items-center gap-2 font-bold font-mono text-[#0667DC]">
            <span className="text-[#3CE68A]">✓</span> Claimed {row.claim?.simulated && <SimulatedBadge />}
          </p>
          {!row.claim && <p className="mt-1 text-sm font-mono">The contract shows this payout as claimed.</p>}
          {row.claim && !row.claim.simulated && (
            <p className="mt-1 text-sm font-mono leading-6">
              {row.amountDisplay} USDC was sent to <span className="break-all">{row.claim.payoutTarget}</span>.
            </p>
          )}
          {row.claim?.simulated && (
            <div className="mt-1 space-y-2 text-sm font-mono leading-6">
              <p>
                {row.claim.payoutStatus === "refunded_simulated"
                  ? "Refunded (simulated failure). The team has been notified; once they reopen your claim you can claim again here."
                  : "Delivered (simulated)."}
              </p>
              <p className="text-[#322E25]/70">
                This is a testnet simulation: nothing arrived on the destination chain, because cross-chain delivery (1Click) only exists on mainnet.
                The contract really paid {row.amountDisplay} test USDC to the holding account <span className="break-all">{row.claim.payoutTarget}</span>.
              </p>
            </div>
          )}
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm font-mono">
            {row.claim?.txHash && <a className="text-xs font-mono text-[#0667DC] underline hover:no-underline" href={explorerTx(info.network, row.claim.txHash)} target="_blank" rel="noreferrer">View the claim transaction</a>}
            {row.claim?.refundTx && <a className="text-xs font-mono text-[#0667DC] underline hover:no-underline" href={explorerTx(info.network, row.claim.refundTx)} target="_blank" rel="noreferrer">View the refund transaction</a>}
          </p>
        </div>
      )}

      {row && !row.claimed && row.claim?.payoutStatus === "reopened" && (
        <p className="border border-[#0667DC]/30 bg-[#e8f1fc] px-3 py-2 text-sm font-mono text-[#0667DC]">
          Your earlier (simulated) payout was refunded and your claim was reopened. You can claim again below.
        </p>
      )}

      {row && !row.claimed && row.claim?.status === "failed" && row.claim.payoutStatus !== "reopened" && (
        <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">
          The last claim attempt did not go through{row.claim.error ? `: ${row.claim.error}` : ""}. Nothing was paid; you can try again.
        </p>
      )}

      {row && !row.claimed && open && !prepared && (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
          <p className="font-bold font-mono uppercase tracking-tight">Get paid</p>
          <p className="mt-1 text-sm font-mono text-[#322E25]/70">The amount is fixed in USDC. You choose only where it goes.</p>
          <div className="mt-4 border border-[#322E25]/15">
            {options === null && <p className="p-4 text-sm font-mono text-[#322E25]/70">Loading options…</p>}
            {options?.map((o) => (
              <label
                key={o.id}
                className={`flex gap-3 border-b border-[#322E25]/10 last:border-b-0 p-4 ${o.available ? "cursor-pointer" : "opacity-70"} ${optionId === o.id ? "bg-[#E9E1CD]" : ""} ${o.id === "near-usdc" ? "border-l-4 border-l-[#0667DC]" : ""}`}
              >
                <input type="radio" name="payout-option" className="mt-1 accent-[#0667DC]" disabled={!o.available} checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="flex items-center gap-2 font-medium font-mono">
                      {o.label}
                      {o.id === "near-usdc" && <RealBadge network={info.network} />}
                      {o.id === "near-usdc" && <span className="text-[10px] uppercase tracking-wider text-[#322E25]/60">Recommended</span>}
                      {o.simulated && <SimulatedBadge />}
                    </p>
                    <p className="font-mono text-sm tabular-nums">
                      {o.estimated ? "~" : ""}
                      {formatUnits(o.estimatedAmountOut, o.decimals)} {o.symbol}
                      {o.estimated && <span className="ml-1 text-xs text-[#322E25]/60">estimated</span>}
                    </p>
                  </div>
                  <p className="mt-1 text-xs font-mono text-[#322E25]/70">
                    {o.feeBps !== undefined && `Fee ~${(o.feeBps / 100).toFixed(2)}% · `}
                    {o.etaSeconds !== undefined && `about ${o.etaSeconds < 60 ? `${o.etaSeconds} s` : `${Math.round(o.etaSeconds / 60)} min`}`}
                    {o.estimatedMinAmountOut && ` · at least ${formatUnits(o.estimatedMinAmountOut, o.decimals)} ${o.symbol} after slippage`}
                  </p>
                  {o.note && <p className="mt-1 text-xs font-mono text-[#8a5a00]">{o.note}</p>}
                  {!o.available && o.unavailableReason && <p className="mt-1 text-xs font-mono text-[#8a5a00]">{o.unavailableReason}</p>}
                </div>
              </label>
            ))}
          </div>

          {optionId !== "near-usdc" && (
            <div className="mt-5">
              <p className="text-sm font-mono leading-6">
                Destination: your own address <span className="break-all">{row.address}</span>.
              </p>
              <p className="mt-1 text-xs font-mono leading-5 text-[#8a5a00]">
                Simulated on testnet: you will sign a real claim and the contract will really pay out, but to a holding account. Nothing will arrive at this address.
              </p>
              <button className="btn mt-4" disabled={busy !== null} onClick={() => void prepare()}>
                {busy === "prepare" ? "Checking…" : "Continue"}
              </button>
            </div>
          )}
          <div className={`mt-5 ${optionId === "near-usdc" ? "" : "hidden"}`}>
            <label className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60" htmlFor="receiver">NEAR account to receive the USDC</label>
            <input id="receiver" className="field num mt-1" value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder={info.network === "mainnet" ? "you.near" : "you.testnet"} autoComplete="off" spellCheck={false} />
            <p className="mt-1.5 text-xs font-mono leading-5 text-[#322E25]/70">
              {row.chain === "evm"
                ? "It goes into the message you sign, so nobody (including our relayer) can send your payout anywhere else. The relayer pays the gas."
                : receiver.trim().toLowerCase() === row.address
                  ? "Gas-free: our relayer submits the claim and pays the network fee. The contract can only pay this payout to your own account."
                  : "Sending to another account: you send the claim from your own NEAR wallet and pay a very small network fee. Your own account is gas-free."}
            </p>
            <button className="btn mt-4" disabled={busy !== null || receiver.trim() === ""} onClick={() => void prepare()}>
              {busy === "prepare" ? "Checking…" : "Continue"}
            </button>
          </div>
        </div>
      )}

      {row && !row.claimed && prepared && (
        <div className="border-2 border-[#322E25] bg-[#E1D7C0]/60 p-6">
          <p className="font-bold font-mono uppercase tracking-tight">Review and sign</p>
          {prepared.summary.simulated ? (
            <div className="mt-1 space-y-2 text-sm font-mono leading-6">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono tabular-nums">{prepared.summary.amountDisplay} USDC</span> as {prepared.summary.label} to <span className="break-all">{prepared.summary.receiver}</span> <SimulatedBadge />
              </p>
              {prepared.summary.estimatedAmountOut && prepared.summary.decimals !== undefined && (
                <p className="text-[#322E25]/70">
                  Estimated from live mainnet quote: ~{formatUnits(prepared.summary.estimatedAmountOut, prepared.summary.decimals)} {prepared.summary.symbol}
                  {prepared.summary.estimatedMinAmountOut && `, at least ${formatUnits(prepared.summary.estimatedMinAmountOut, prepared.summary.decimals)} after slippage`}.
                </p>
              )}
              <p className="border border-[#8a5a00]/40 bg-[#fbf0d6] px-3 py-2 text-[#8a5a00]">
                {prepared.summary.note} Holding account: <span className="break-all">{prepared.summary.holdingAccount}</span>.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-sm font-mono leading-6">
              <span className="tabular-nums">{prepared.summary.amountDisplay} USDC</span> on NEAR to <span className="break-all">{prepared.summary.receiver}</span>.
            </p>
          )}
          {prepared.kind === "evm" ? (
            <>
              <p className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60 mt-4">Message your wallet will show</p>
              <pre className="font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all border border-[#322E25]/20 bg-[#E9E1CD] p-3 mt-1">{prepared.message}</pre>
              <p className="mt-2 text-xs font-mono text-[#322E25]/70">Sign within 10 minutes (expires {new Date(prepared.expiresAtMs).toLocaleTimeString()}). Signing costs nothing.</p>
            </>
          ) : prepared.relayed ? (
            <p className="mt-2 text-xs font-mono text-[#322E25]/70">Gas-free: nothing to sign and no NEAR needed. Our relayer submits the claim and pays the network fee; the contract can only pay your own account.</p>
          ) : (
            <p className="mt-2 text-xs font-mono text-[#322E25]/70">You chose another account, so your NEAR wallet will ask you to approve a call to <span className="break-all">{prepared.call.contractId}</span> and you pay a small network fee. Claiming to your own account is gas-free.</p>
          )}
          <div className="mt-4 flex gap-3">
            <button className="btn" disabled={busy !== null} onClick={() => void signAndSubmit()}>
              {prepared.kind === "near" && prepared.relayed
                ? busy === "submit" ? "Claiming…" : "Claim (gas-free)"
                : busy === "submit" ? "Signing and sending…" : prepared.kind === "evm" ? "Sign and claim" : "Claim from my wallet"}
            </button>
            <button className="btn-quiet" disabled={busy !== null} onClick={() => setPrepared(null)}>Back</button>
          </div>
        </div>
      )}

      {row && !row.claimed && !open && <p className="border border-[#8a5a00]/40 bg-[#fbf0d6] px-3 py-2 text-sm font-mono text-[#8a5a00]">This run is not accepting claims right now.</p>}
    </div>
  );
}

/** Open link → connect wallet → get paid. */
function ClaimSteps({ current }: { current: 2 | 3 | 4 }) {
  // Step 1 (open the link) is done once this page shows; 4 means every step is done (claimed).
  const steps = ["Open link", "Connect wallet", "Get paid"];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono uppercase tracking-widest" aria-label="Claim steps">
      {steps.map((label, i) => {
        const n = i + 1;
        const complete = n < current;
        const active = n === current && !complete;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={`flex h-5 w-5 items-center justify-center border text-[10px] ${complete ? "border-[#0667DC] bg-[#0667DC] text-white" : active ? "border-[#0667DC] text-[#0667DC]" : "border-[#322E25]/30 text-[#322E25]/50"}`}
            >
              {complete ? "✓" : n}
            </span>
            <span className={complete || active ? "text-[#322E25]" : "text-[#322E25]/50"}>{label}</span>
            {n < steps.length && <span className="text-[#322E25]/30">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
