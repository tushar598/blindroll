"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { type PayeeDraft, buildPayeeCsv } from "@/lib/client/payees";
import { NearWalletChoice, useNearWalletChoice } from "./near-wallet-choice";
import { useSession } from "./session";
import { StatusPill } from "./status-pill";

interface RunListItem {
  runKey: string;
  name: string;
  status: string;
  createdAt: string;
  createdBy: string;
  recipientCount: number | null;
  totalAmount: string | null;
}

export function Dashboard() {
  const { me, loading, busy, error, signIn } = useSession();
  const wallet = useNearWalletChoice();
  if (loading) return <p className="text-sm font-mono text-[#322E25]/60">Loading…</p>;
  if (!me?.accountId) {
    return (
      <div className="space-y-10">
        {/* Dual-Row Brutalist Marquee Banner (Matching Reference Design) */}
        <div
          aria-hidden="true"
          className="bg-[#E1D7C0] border-y border-[#322E25]/15 overflow-hidden select-none -mx-5 sm:-mx-8"
        >
          <div className="py-2 border-b border-[#322E25]/10">
            <div className="animate-marquee-left flex items-center gap-8 text-[11px] font-mono tracking-widest uppercase text-[#322E25]/80">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-8 shrink-0">
                  <span>BUILD WITHOUT PERMISSION</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>NO PUBLIC SALARY TABLE</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>PRIVACY &amp; PRIVATE AI</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>MERKLE PROOFS ON NEAR</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>USDC SETTLEMENT</span>
                  <span className="text-[#0667DC]">✳</span>
                </div>
              ))}
            </div>
          </div>
          <div className="py-2">
            <div className="animate-marquee-right flex items-center gap-8 text-[10px] font-mono tracking-widest uppercase text-[#322E25]/60">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-8 shrink-0">
                  <span>REAL-WORLD MONEY</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>ONE-CLICK CLAIMS</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>TEE-HOSTED AI</span>
                  <span className="text-[#0667DC]">✳</span>
                  <span>MONEY WITH A MIND OF ITS OWN</span>
                  <span className="text-[#0667DC]">✳</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Hero Section */}
        <div className="pt-4 pb-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-[#0667DC] mb-3">
            NEAR HACKATHON · REAL-WORLD MONEY + PRIVACY &amp; PRIVATE AI
          </div>
          <h1 className="text-4xl sm:text-6xl md:text-[68px] font-bold tracking-[-0.04em] leading-[0.95] text-[#322E25] uppercase mb-4">
            RUN PAYROLL WITHOUT
            <br />
            <span className="text-[#0667DC]">A PUBLIC TABLE.</span>
          </h1>
          <p className="max-w-2xl text-xs sm:text-sm font-mono text-[#322E25]/75 leading-relaxed">
            Upload a payroll sheet, have it checked by private AI, and lock funds in a smart contract.
            Payroll data is processed privately; only a Merkle root and a report hash go on-chain.
            Each contributor sees only their own row and claims it themselves.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button className="btn" onClick={() => void signIn()} disabled={busy || !me}>
              <span>{busy ? "Check your wallet…" : "Sign in as an approver"}</span>
              <span className="text-xs">↗</span>
            </button>
            <span className="text-xs text-[#322E25]/70 font-mono">{wallet.label} wallet · {me?.network ?? "testnet"}</span>
          </div>
          <div className="mt-4">
            <NearWalletChoice choice={wallet} disabled={busy} />
          </div>
          {error && <p className="mt-4 max-w-xl border border-[#a3271f]/30 bg-[#f8e6e2] px-3.5 py-2.5 text-xs font-mono text-[#a3271f]">{error}</p>}
        </div>

        {/* 00 / SYSTEM INFO — COBALT BLUE BANNER (Signature Reference Component) */}
        <section className="bg-[#0667DC] text-white p-6 sm:p-10 border border-[#322E25]/15">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-7">
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/75 mb-2">
                00 / PROTOCOL SPECS
              </div>
              <h2 className="text-2xl sm:text-4xl font-bold tracking-tight uppercase leading-tight">
                THE SYSTEM
                <br />
                AT A GLANCE
              </h2>
              <p className="mt-3 text-xs sm:text-[13px] font-mono text-white/85 leading-relaxed max-w-lg">
                No public salary table. Names, roles, memos, and individual amounts never touch the blockchain until the moment of claim. Only cryptographic roots and verified report hashes reside on NEAR.
              </p>
            </div>
            <div className="lg:col-span-5 border border-white/25 p-5 bg-black/15">
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/80 mb-3 pb-2 border-b border-white/20">
                ON-CHAIN METRICS
              </div>
              <div className="space-y-2.5 text-xs font-mono">
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-white/75">SALARY DATA ON-CHAIN</span>
                  <span className="font-bold text-[#3CE68A]">0 BYTES</span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-white/75">PROOF PRIMITIVE</span>
                  <span className="font-bold">MERKLE TREE</span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-white/75">AI ENGINE</span>
                  <span className="font-bold">NEAR AI CLOUD (TEE)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/75">TOKEN STANDARD</span>
                  <span className="font-bold">NEP-141 (USDC)</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 01 / EXECUTION PLAN — IDEA > BUILD > DEMO STYLE */}
        <section className="pt-2">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6 pb-3 border-b border-[#322E25]/15">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC] mb-1">
                01 / EXECUTION PIPELINE
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold uppercase tracking-tight">
                CSV &gt; MERKLE ROOT &gt; <span className="text-[#0667DC]">CLAIM</span>
              </h2>
            </div>
            <p className="text-xs font-mono text-[#322E25]/60 max-w-xs">
              Four stages. Only a Merkle root and a report hash go on-chain.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { num: '01', title: 'Upload & Parse', desc: 'Upload any messy payroll CSV. NEAR AI Cloud (a TEE-hosted model) proposes the column mapping from the header and 5 sample rows, emails masked. The response is signed.' },
              { num: '02', title: 'Rules & Edits', desc: 'Addresses, formats, and totals are validated. Outliers require written reasons before approval.' },
              { num: '03', title: 'Lock & Fund', desc: 'Rows become salted Merkle leaves. Approvers sign on NEAR to store the root and lock USDC.' },
              { num: '04', title: 'Self-Serve Claim', desc: 'Recipients sign a view challenge to reveal their row and claim directly to NEAR or cross-chain via 1Click.' },
            ].map((step) => (
              <div key={step.num} className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-5">
                <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#322E25]/15">
                  <span className="text-2xl font-mono text-[#0667DC] font-bold">{step.num}</span>
                  <span className="text-xs font-mono text-[#322E25]/40">→</span>
                </div>
                <h3 className="text-sm font-bold uppercase tracking-tight mb-1.5">{step.title}</h3>
                <p className="text-xs font-mono text-[#322E25]/75 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 02 / PRIVACY CONTRACT — WHAT IS AND ISN'T PUBLIC */}
        <section className="pt-4">
          <div className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC] mb-2">
            02 / PRIVACY CONTRACT
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold uppercase tracking-tight mb-6">
            WHAT GOES ON-CHAIN VS <span className="text-[#0667DC]">OFF-CHAIN</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
              <div className="text-[11px] font-mono uppercase tracking-widest text-[#0667DC] mb-3 pb-2 border-b border-[#322E25]/15">
                [ 01 / PUBLIC ON NEAR ]
              </div>
              <ul className="space-y-3 text-xs font-mono text-[#322E25]/85">
                <li className="flex items-start gap-2.5">
                  <span className="text-[#0667DC] font-bold">✓</span>
                  <span>Run key, approvers list, threshold, and claim deadline</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#0667DC] font-bold">✓</span>
                  <span>Total funded USDC amount locked in contract vault</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#0667DC] font-bold">✓</span>
                  <span>Merkle root and canonical report hash (sha256)</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#0667DC] font-bold">✓</span>
                  <span>Each claim: that one recipient&apos;s address, amount and transfer</span>
                </li>
              </ul>
            </div>

            <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6">
              <div className="text-[11px] font-mono uppercase tracking-widest text-[#322E25]/60 mb-3 pb-2 border-b border-[#322E25]/15">
                [ 02 / OFF-CHAIN, NOT PUBLIC ]
              </div>
              <ul className="space-y-3 text-xs font-mono text-[#322E25]/85">
                <li className="flex items-start gap-2.5">
                  <span className="text-[#322E25]/40 font-bold">×</span>
                  <span>The full salary table and all unclaimed rows</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#322E25]/40 font-bold">×</span>
                  <span>Names, emails, job roles, and contributor memos</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#322E25]/40 font-bold">×</span>
                  <span>AI prompts and raw responses (only their hashes and the signature are in the report)</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="text-[#322E25]/40 font-bold">×</span>
                  <span>Individual salary amounts before a claim is submitted</span>
                </li>
              </ul>
              <p className="mt-4 pt-3 border-t border-[#322E25]/15 text-[11px] font-mono leading-5 text-[#322E25]/70">
                Off-chain still means the Blindroll server can read the full table (encrypted at rest) and the approvers review it. Future work: run the backend in a TEE.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }
  return <ApproverHome orgId={me.org.id} orgName={me.org.name} aiLive={me.aiLive} />;
}

function ApproverHome({ orgId, orgName, aiLive }: { orgId: string; orgName: string; aiLive: boolean }) {
  const router = useRouter();
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [payees, setPayees] = useState<PayeeDraft[]>([]);
  const [draft, setDraft] = useState<PayeeDraft>({ name: "", wallet: "", amount: "", memo: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ runs: RunListItem[] }>("/api/runs")
      .then((r) => setRuns(r.runs))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    await send(file, name.trim() || file.name.replace(/\.csv$/i, ""));
  }

  /** Typed payees become an ordinary CSV and go through the same upload, mapping and rules. */
  async function uploadPayees() {
    if (payees.length === 0) return;
    const csv = new File([buildPayeeCsv(payees)], "payees.csv", { type: "text/csv" });
    await send(csv, name.trim() || `Payees ${new Date().toISOString().slice(0, 10)}`, "payees");
  }

  function addPayee(e: FormEvent) {
    e.preventDefault();
    if (draft.wallet.trim() === "" || draft.amount.trim() === "") return;
    setPayees((p) => [...p, { name: draft.name.trim(), wallet: draft.wallet.trim(), amount: draft.amount.trim(), memo: draft.memo.trim() }]);
    setDraft({ name: "", wallet: "", amount: "", memo: "" });
  }

  async function send(csv: File, runName: string, source: "csv" | "payees" = "csv") {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", csv);
      form.set("name", runName);
      form.set("source", source);
      form.set("orgId", orgId);
      const { runKey } = await api<{ runKey: string }>("/api/runs", { form });
      router.push(`/runs/${runKey}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_1.4fr]">
      <section>
        <p className="text-[10px] font-mono uppercase tracking-widest text-[#0667DC] mb-1">{orgName}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight uppercase font-mono">New payroll run</h1>
        <form onSubmit={upload} className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6 mt-4 space-y-4 font-mono">
          <div>
            <label className="label" htmlFor="run-name">Run name</label>
            <input id="run-name" className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="October contributors" maxLength={100} />
          </div>
          <div>
            <label className="label" htmlFor="run-file">Payroll CSV</label>
            <input id="run-file" className="field mt-1" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="mt-1.5 text-xs text-[#322E25]/60 leading-5">Any column names, any order. Up to 500 rows, 2 MB.</p>
          </div>
          <button className="btn w-full" disabled={!file || busy}>{busy ? "Reading the file…" : "Upload and check"}</button>
          <p className="text-xs text-[#322E25]/60 leading-5">
            {aiLive
              ? "The header and up to 5 sample rows (emails masked) are sent to NEAR AI Cloud to map the columns. Code does everything else."
              : "Live AI mapping is off (NEAR_AI_LIVE=0). A file that was mapped before reuses its stored mapping; otherwise you map the columns by hand."}
          </p>
          {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f]">{error}</p>}
        </form>

        <details className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-6 mt-4 font-mono">
          <summary className="cursor-pointer text-sm font-bold uppercase tracking-tight">Or add payees by hand</summary>
          <p className="mt-2 text-xs text-[#322E25]/60 leading-5">
            For a few contractors without a spreadsheet. The rows become a CSV and go through the same column mapping, rule checks and review as an upload.
          </p>
          <form onSubmit={addPayee} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="payee-name">Name</label>
              <input id="payee-name" className="field mt-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} />
            </div>
            <div>
              <label className="label" htmlFor="payee-wallet">Wallet</label>
              <input id="payee-wallet" className="field num mt-1" value={draft.wallet} onChange={(e) => setDraft({ ...draft, wallet: e.target.value })} placeholder="name.testnet or 0x…" spellCheck={false} autoComplete="off" maxLength={100} />
            </div>
            <div>
              <label className="label" htmlFor="payee-amount">Amount (USDC)</label>
              <input id="payee-amount" className="field num mt-1" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="1200.50" inputMode="decimal" maxLength={30} />
            </div>
            <div>
              <label className="label" htmlFor="payee-memo">Memo</label>
              <input id="payee-memo" className="field mt-1" value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} placeholder="October invoice" maxLength={200} />
            </div>
            <button className="btn-quiet sm:col-span-2" disabled={busy || draft.wallet.trim() === "" || draft.amount.trim() === "" || payees.length >= 500}>Add payee</button>
          </form>
          {payees.length > 0 && (
            <>
              <ul className="mt-4 divide-y divide-[#322E25]/10 border-y border-[#322E25]/15 text-xs">
                {payees.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate">
                      {p.name || "(no name)"} · <span className="num">{p.wallet}</span> · <span className="num font-semibold">{p.amount}</span>
                      {p.memo && ` · ${p.memo}`}
                    </span>
                    <button type="button" className="shrink-0 underline text-[#322E25]/60" disabled={busy} onClick={() => setPayees((all) => all.filter((_, j) => j !== i))}>Remove</button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn w-full mt-4" disabled={busy} onClick={() => void uploadPayees()}>
                {busy ? "Reading the payees…" : `Check ${payees.length} payee${payees.length === 1 ? "" : "s"}`}
              </button>
              <p className="mt-2 text-xs text-[#322E25]/60 leading-5">
                AI mapping not needed: the columns are fixed, so no NEAR AI Cloud call is made. The rules and the review are the same as for a file.
              </p>
            </>
          )}
        </details>
      </section>
      <section>
        <p className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60 mb-2 font-mono">Runs</p>
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 mt-2 divide-y divide-[#322E25]/10">
          {runs === null && <p className="p-5 text-sm font-mono text-[#322E25]/60">Loading…</p>}
          {runs?.length === 0 && <p className="p-5 text-sm font-mono text-[#322E25]/60">No runs yet. Upload a CSV to start one.</p>}
          {runs?.map((r) => (
            <Link key={r.runKey} href={`/runs/${r.runKey}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-[#E1D7C0] transition-colors">
              <div className="min-w-0">
                <p className="truncate font-medium font-mono text-sm text-[#322E25]">{r.name}</p>
                <p className="mt-0.5 truncate text-xs text-[#322E25]/60 font-mono">{r.runKey} · {new Date(r.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                {r.recipientCount !== null && <span className="text-xs text-[#322E25]/60 font-mono">{r.recipientCount} recipients</span>}
                <StatusPill status={r.status} />
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
