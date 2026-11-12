"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { type ReportVerification, checkAttestationEvidence, verifyPublishedReport } from "@blindroll/core";
import { api, errorMessage } from "@/lib/client/api";
import { viewContract } from "@/lib/client/chain";
import { explorerAccount, explorerTx } from "@/lib/client/wallet";
import { useSession } from "./session";

interface RunInfo {
  runKey: string;
  runName: string;
  orgName: string;
  status: string;
  network: string;
  contractId: string;
  createTx: string | null;
}
interface OnChain {
  merkle_root: string;
  report_hash: string;
  status: string;
  recipient_count: number;
  total_amount: string;
}
/** group "ai" = the NEAR AI Cloud signature and TEE attestation checks, shown in their own list. */
type Check = { state: "pass" | "fail" | "info" | "not_verified"; title: string; detail: string; group?: "ai" };
interface Result {
  v: ReportVerification;
  chain: { run: OnChain | null; rpcUrl: string; blockHeight: number } | { error: string };
  checks: Check[];
  at: string;
}

function usdc(base: string): string {
  const n = BigInt(base);
  const whole = (n / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(n % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}

/** Everything here runs in the browser: the hash, the signature recovery and the RPC read. */
async function runChecks(info: RunInfo): Promise<Result> {
  const res = await fetch(`/api/runs/${info.runKey}/report`, { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 ? "This run has no report yet (it is not finalized)." : `The report could not be loaded (HTTP ${res.status})`);
  const text = await res.text();
  const v = await verifyPublishedReport(text);
  const checks: Check[] = [];
  let chain: Result["chain"];
  try {
    const c = await viewContract<OnChain | null>(info.network, info.contractId, "get_run", { run_key: info.runKey });
    chain = { run: c.value, rpcUrl: c.rpcUrl, blockHeight: c.blockHeight };
  } catch (err) {
    chain = { error: errorMessage(err) };
  }

  if (!v.report) {
    checks.push({ state: "fail", title: "Report format", detail: v.problem ?? "The report could not be read." });
    return { v, chain, checks, at: new Date().toISOString() };
  }
  const r = v.report;
  checks.push(
    v.canonical
      ? { state: "pass", title: "Report hash recomputed", detail: `sha256 of the report bytes, computed in this browser: ${v.sha256}` }
      : { state: "fail", title: "Report hash recomputed", detail: `The report is not in canonical form (RFC 8785), so its hash is not well defined. sha256 of the bytes served: ${v.sha256}` },
  );
  if ("error" in chain) {
    checks.push({ state: "fail", title: "Report hash on the contract", detail: `The contract could not be read: ${chain.error}` });
  } else if (chain.run === null) {
    checks.push({ state: "fail", title: "Report hash on the contract", detail: `The contract ${info.contractId} has no run "${info.runKey}" yet (create_run has not been sent).` });
  } else {
    const hashOk = chain.run.report_hash === v.sha256;
    checks.push({
      state: hashOk ? "pass" : "fail",
      title: "Report hash on the contract",
      detail: hashOk
        ? `The contract stores the same hash (read from ${new URL(chain.rpcUrl).host} at block ${chain.blockHeight}).`
        : `The contract stores ${chain.run.report_hash}, which differs from this report.`,
    });
    const rootOk = chain.run.merkle_root === r.merkle.root;
    checks.push({
      state: rootOk ? "pass" : "fail",
      title: "Merkle root on the contract",
      detail: rootOk ? `The contract stores the report's Merkle root ${r.merkle.root}.` : `The contract stores ${chain.run.merkle_root}; the report says ${r.merkle.root}.`,
    });
    const totalsOk = chain.run.total_amount === r.normalized.total_amount && chain.run.recipient_count === r.normalized.recipient_count;
    checks.push({
      state: totalsOk ? "pass" : "fail",
      title: "Total and recipient count",
      detail: totalsOk
        ? `${usdc(r.normalized.total_amount)} USDC to ${r.normalized.recipient_count} recipients, in both the report and the contract.`
        : `Report: ${r.normalized.total_amount} base units to ${r.normalized.recipient_count} recipients. Contract: ${chain.run.total_amount} to ${chain.run.recipient_count}.`,
    });
  }
  if (r.run_key !== info.runKey || r.contract_id !== info.contractId || r.network !== info.network) {
    checks.push({ state: "fail", title: "Report belongs to this run", detail: `The report names run ${r.run_key} on ${r.contract_id} (${r.network}).` });
  }
  const ai = v.ai;
  if (ai?.state === "verified") {
    checks.push({
      group: "ai",
      state: "pass",
      title: "Response signature (NEAR AI Cloud)",
      detail: `The signature over "${ai.signedText}" (model, request hash, response hash) recovers to ${ai.signer}, the signing address in the report.`,
    });
  } else if (ai?.state === "failed") {
    checks.push({ group: "ai", state: "fail", title: "Response signature (NEAR AI Cloud)", detail: `Not valid: ${ai.reason}.` });
  } else if (ai?.state === "unsigned") {
    checks.push({ group: "ai", state: "fail", title: "Response signature (NEAR AI Cloud)", detail: "An AI call mapped the columns, but the report holds no signature for it." });
  } else {
    checks.push({ group: "ai", state: "info", title: "Response signature (NEAR AI Cloud)", detail: "Not applicable: the approver mapped the columns by hand, so no AI call backs this run." });
  }
  if (r.ai) {
    // The raw attestation is served by our backend; its sha256 is in the report, whose hash is on-chain.
    let attestationText: string | null = null;
    try {
      const a = await fetch(`/api/runs/${info.runKey}/attestation`, { cache: "no-store" });
      if (a.ok) attestationText = await a.text();
    } catch {
      attestationText = null;
    }
    const ev = checkAttestationEvidence({ ai: r.ai, attestationText });
    for (const c of ev.checks) checks.push({ group: "ai", state: c.state, title: c.title, detail: c.detail });
  }
  return { v, chain, checks, at: new Date().toISOString() };
}

function Row({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? "num text-xs text-[#322E25]" : "text-sm text-[#322E25]"}`}>{value}</dd>
    </div>
  );
}

const MARK: Record<Check["state"], { sign: string; cls: string; word: string }> = {
  pass: { sign: "✓", cls: "text-[#0667DC]", word: "Passed" },
  fail: { sign: "✗", cls: "text-[#a3271f]", word: "Failed" },
  info: { sign: "–", cls: "text-[#322E25]/60", word: "Note" },
  not_verified: { sign: "○", cls: "text-[#8a5a00]", word: "Not verified" },
};

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="mt-3 divide-y divide-[#322E25]/10 border-t border-[#322E25]/15">
      {checks.map((c) => (
        <li key={c.title} className="flex gap-3 py-3 text-sm">
          <span className={`w-4 shrink-0 text-base font-semibold leading-5 ${MARK[c.state].cls}`} aria-hidden>
            {MARK[c.state].sign}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-xs uppercase tracking-wide">
              {c.title} <span className={`ml-1 text-[10px] font-normal ${MARK[c.state].cls}`}>{MARK[c.state].word}</span>
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-[#322E25]/60">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ReportScreen() {
  const { runKey } = useParams<{ runKey: string }>();
  const { me } = useSession();
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<RunInfo>(`/api/claim/${runKey}`)
      .then((i) => {
        if (!live) return;
        setInfo(i);
        setBusy(true);
        return runChecks(i).then((r) => live && setResult(r));
      })
      .catch((err) => live && setError(errorMessage(err)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [runKey]);

  async function verify() {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await runChecks(info));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <p className={`text-sm font-mono ${error ? "border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-[#a3271f]" : "text-[#322E25]/60"}`}>{error ?? "Loading…"}</p>;
  const r = result?.v.report ?? null;
  const failed = result?.checks.filter((c) => c.state === "fail").length ?? 0;
  const passed = result?.checks.filter((c) => c.state === "pass").length ?? 0;
  const notVerified = result?.checks.filter((c) => c.state === "not_verified").length ?? 0;
  const reportChecks = result?.checks.filter((c) => c.group !== "ai") ?? [];
  const aiChecks = result?.checks.filter((c) => c.group === "ai") ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 font-mono">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC]">{info.orgName} · Report</p>
        <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight uppercase">{info.runName}</h1>
        <p className="mt-2 text-sm leading-6 text-[#322E25]/70">
          The report records how this payroll run was prepared. It holds hashes and counts only: no names, addresses or per-person amounts.
          Its hash is stored on the contract, so it cannot be changed afterwards without the check below failing.
        </p>
      </div>
      {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f]">{error}</p>}

      <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-bold text-base">
              {!result
                ? "Checking…"
                : `${passed} passed · ${failed} failed${notVerified > 0 ? ` · ${notVerified} not verified` : ""}`}
            </p>
            <p className="mt-0.5 text-xs text-[#322E25]/60">
              Checked in your browser{result ? ` at ${new Date(result.at).toLocaleTimeString()}` : ""}: the hash and the signature are recomputed here, and the contract is read from a public NEAR RPC.
            </p>
          </div>
          <button className="btn" disabled={busy} onClick={() => void verify()}>
            {busy ? "Verifying…" : "Verify again"}
          </button>
        </div>
        {result && (
          <>
            <p className="mt-5 text-[10px] font-mono uppercase tracking-widest text-[#0667DC]">Report and contract</p>
            <CheckList checks={reportChecks} />
            <p className="mt-5 text-[10px] font-mono uppercase tracking-widest text-[#0667DC]">AI signature and TEE attestation</p>
            <p className="mt-1 text-xs leading-5 text-[#322E25]/70">
              Each check is listed on its own. The attestation checks show the evidence is consistent with the signed response.
              They do not prove it came from real TDX hardware until the Intel quote signature is verified, which this version does not do.
            </p>
            <CheckList checks={aiChecks} />
          </>
        )}
      </div>

      {r && (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
          <p className="font-bold text-base uppercase tracking-tight">What the report says</p>
          <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Row label="Uploaded CSV (sha256)" value={r.inputs.csv_sha256} />
            <Row label="Final table (sha256)" value={r.normalized.table_sha256} />
            <Row label="Merkle root" value={r.merkle.root} />
            <Row label="Report hash (sha256)" value={result!.v.sha256} />
            <Row label="Total" mono={false} value={<span className="num font-semibold">{usdc(r.normalized.total_amount)} USDC to {r.normalized.recipient_count} recipients</span>} />
            <Row label="Rows in the file" mono={false} value={<span className="num font-semibold">{r.inputs.row_count}</span>} />
            <Row label="Approval policy" mono={false} value={`${r.approval_policy.threshold} of ${r.approval_policy.approvers.length}: ${r.approval_policy.approvers.join(", ")}`} />
            <Row label="Prepared" mono={false} value={new Date(r.created_at).toLocaleString()} />
            <Row
              label="Contract"
              value={<a className="text-[#0667DC] underline" href={explorerAccount(info.network, info.contractId)} target="_blank" rel="noreferrer">{info.contractId}</a>}
            />
            <Row
              label="Transaction that stored the hash"
              value={
                info.createTx ? (
                  <a className="text-[#0667DC] underline" href={explorerTx(info.network, info.createTx)} target="_blank" rel="noreferrer">{info.createTx}</a>
                ) : (
                  <span className="text-[#322E25]/50">Not recorded{result && !("error" in result.chain) && result.chain.run ? " (the run is on the contract; see the check above)" : ""}</span>
                )
              }
            />
          </dl>

          <p className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC] mt-6 mb-1">Rule checks ({r.rules.version})</p>
          <p className="text-sm">
            {r.rules.errors} errors, {r.rules.warnings} warning{r.rules.warnings === 1 ? "" : "s"}; {r.edits.count} edit{r.edits.count === 1 ? "" : "s"} to the uploaded file.
          </p>
          {r.rules.results.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {r.rules.results.map((x, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="num text-xs font-semibold">{x.rule_id}</span>
                  <span className="text-[#322E25]/60">{x.overridden ? "accepted by an approver with a written reason" : "open"}</span>
                </li>
              ))}
            </ul>
          )}
          {r.notes.length > 0 && <p className="mt-2 text-sm text-[#322E25]/60">Notes: {r.notes.join("; ")}.</p>}

          <p className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC] mt-6 mb-1">Column mapping</p>
          {r.ai ? (
            <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row label="Model (NEAR AI Cloud)" value={r.ai.model} />
              <Row label="Signing address" value={r.ai.signature?.signing_address ?? "none"} />
              <Row label="Request (sha256)" value={r.ai.request_sha256} />
              <Row label="Response (sha256)" value={r.ai.response_sha256} />
            </dl>
          ) : (
            <p className="mt-1 text-sm">Mapped by hand by an approver. No AI call was used.</p>
          )}
          <p className="mt-3 text-xs leading-5 text-[#322E25]/60">
            The AI only proposed which CSV column is which. Amounts, addresses and every rule check are computed by code.
          </p>

          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a className="font-semibold text-[#0667DC] underline" href={`/api/runs/${runKey}/report`} target="_blank" rel="noreferrer">Open the report JSON</a>
          </div>
        </div>
      )}

      {me?.accountId && (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
          <p className="font-bold text-base uppercase tracking-tight">Reconciled export</p>
          <p className="mt-1 text-sm leading-6 text-[#322E25]/70">
            One row per recipient: claimed, unclaimed, refunded or reopened, with the payout rail, destination and transaction hashes.
            Claimed status is read from the contract. For approvers only: the file holds names, addresses and amounts.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a className="btn-quiet" href={`/api/runs/${runKey}/export?format=csv`}>Download CSV</a>
            <a className="btn-quiet" href={`/api/runs/${runKey}/export?format=json`}>Download JSON</a>
            <Link className="self-center text-sm underline text-[#0667DC]" href={`/runs/${runKey}`}>Back to the run</Link>
          </div>
        </div>
      )}
    </div>
  );
}
