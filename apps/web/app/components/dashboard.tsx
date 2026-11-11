"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
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
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (!me?.accountId) {
    return (
      <div className="grid gap-10 pt-6 md:grid-cols-[1.2fr_1fr]">
        <section>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight">Run payroll without publishing a salary table.</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted">
            Upload a payroll sheet, have it checked, and lock the funds in a contract. Payroll data is processed privately; only a Merkle
            root and a report hash go on-chain. Each contributor sees only their own row and claims it themselves.
          </p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
            Payouts are standard on-chain transfers: a claim reveals that claimant&apos;s address and amount.
          </p>
          <div className="mt-8 flex items-center gap-4">
            <button className="btn" onClick={() => void signIn()} disabled={busy || !me}>
              {busy ? "Check your wallet…" : "Sign in as an approver"}
            </button>
            <span className="text-sm text-muted">Meteor wallet, {me?.network ?? "testnet"}</span>
          </div>
          {error && <p className="mt-4 max-w-xl rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}
        </section>
        <aside className="card self-start p-5 text-sm leading-6">
          <p className="label">What goes on-chain</p>
          <ul className="mt-3 space-y-2">
            <li>The run, its approvers and deadline</li>
            <li>The total funded amount</li>
            <li>A Merkle root and the report hash</li>
          </ul>
          <p className="label mt-5">What stays off-chain</p>
          <ul className="mt-3 space-y-2">
            <li>The full table and unclaimed rows</li>
            <li>Names, emails, roles and memos</li>
            <li>AI prompts and responses (only their hashes are in the report)</li>
          </ul>
        </aside>
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
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("name", name.trim() || file.name.replace(/\.csv$/i, ""));
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
        <p className="label">{orgName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">New payroll run</h1>
        <form onSubmit={upload} className="card mt-4 space-y-4 p-5">
          <div>
            <label className="label" htmlFor="run-name">Run name</label>
            <input id="run-name" className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="October contributors" maxLength={100} />
          </div>
          <div>
            <label className="label" htmlFor="run-file">Payroll CSV</label>
            <input id="run-file" className="field mt-1" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="mt-1.5 text-xs leading-5 text-muted">Any column names, any order. Up to 500 rows, 2 MB.</p>
          </div>
          <button className="btn w-full" disabled={!file || busy}>{busy ? "Reading the file…" : "Upload and check"}</button>
          <p className="text-xs leading-5 text-muted">
            {aiLive
              ? "The header and up to 5 sample rows (emails masked) are sent to NEAR AI Cloud to map the columns. Code does everything else."
              : "Live AI mapping is off (NEAR_AI_LIVE=0). A file that was mapped before reuses its stored mapping; otherwise you map the columns by hand."}
          </p>
          {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}
        </form>
      </section>
      <section>
        <p className="label">Runs</p>
        <div className="card mt-2 divide-y divide-line">
          {runs === null && <p className="p-5 text-sm text-muted">Loading…</p>}
          {runs?.length === 0 && <p className="p-5 text-sm text-muted">No runs yet. Upload a CSV to start one.</p>}
          {runs?.map((r) => (
            <Link key={r.runKey} href={`/runs/${r.runKey}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-accent-soft">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.name}</p>
                <p className="num mt-0.5 truncate text-xs text-muted">{r.runKey} · {new Date(r.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                {r.recipientCount !== null && <span className="text-sm text-muted">{r.recipientCount} recipients</span>}
                <StatusPill status={r.status} />
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
