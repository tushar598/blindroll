"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { RunView } from "@/lib/client/types";
import { ChainSteps } from "./chain-steps";
import { MappingPanel } from "./mapping-panel";
import { SandboxBadge, TrustNotice } from "./notices";
import { PayoutsPanel } from "./payouts-panel";
import { ReviewPanel } from "./review-panel";
import { useSession } from "./session";
import { StatusPill } from "./status-pill";

export function RunScreen() {
  const { runKey } = useParams<{ runKey: string }>();
  const { me, loading: sessionLoading } = useSession();
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRun(await api<RunView>(`/api/runs/${runKey}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [runKey]);

  const signedIn = Boolean(me?.accountId);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api<RunView>(`/api/runs/${runKey}`)
      .then((r) => live && setRun(r))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [signedIn, runKey]);

  if (sessionLoading) return <p className="text-sm font-mono text-[#322E25]/60">Loading…</p>;
  if (!me?.accountId) return <p className="text-sm font-mono text-[#322E25]/60">Sign in as an approver to open this run.</p>;
  if (error && !run) return <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{error}</p>;
  if (!run) return <p className="text-sm font-mono text-[#322E25]/60">Loading run…</p>;

  const mapped = run.mapping !== null;
  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm font-mono text-[#322E25]/60 hover:text-[#0667DC] transition-colors">← All runs</Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl font-bold tracking-tight uppercase font-mono">{run.name}</h1>
          <StatusPill status={run.status} />
        </div>
        <p className="text-xs font-mono text-[#322E25]/60 mt-1">
          {run.runKey} · {run.org.name} · {run.org.threshold} of {run.org.approvers.length} approvers
        </p>
        {run.sandbox && <div className="mt-2"><SandboxBadge /></div>}
      </div>
      <TrustNotice />
      {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{error}</p>}

      <Section n={1} title="Columns" done={mapped}>
        <MappingPanel run={run} onChanged={reload} />
      </Section>

      {mapped && (
        <Section n={2} title="Review" done={run.finalized !== null}>
          <ReviewPanel run={run} onChanged={reload} />
        </Section>
      )}

      {run.finalized && (
        <Section n={3} title="On-chain" done={run.status === "active" || run.status === "closed"}>
          <ChainSteps run={run} accountId={me.accountId} onChanged={reload} />
        </Section>
      )}

      {(run.status === "active" || run.status === "closed") && (
        <Section n={4} title="Claims" done={false}>
          <PayoutsPanel run={run} />
        </Section>
      )}
    </div>
  );
}

function Section({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className={`flex h-7 w-7 items-center justify-center border text-xs font-mono ${done ? "border-[#0667DC] bg-[#0667DC] text-white" : "border-[#322E25]"}`}>
          {done ? "✓" : n}
        </span>
        <h2 className="text-base font-bold font-mono uppercase tracking-wider">{title}</h2>
      </div>
      {children}
    </section>
  );
}
