"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { RunView } from "@/lib/client/types";
import { ChainSteps } from "./chain-steps";
import { MappingPanel } from "./mapping-panel";
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

  if (sessionLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (!me?.accountId) return <p className="text-sm text-muted">Sign in as an approver to open this run.</p>;
  if (error && !run) return <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>;
  if (!run) return <p className="text-sm text-muted">Loading run…</p>;

  const mapped = run.mapping !== null;
  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-muted hover:text-ink">← All runs</Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{run.name}</h1>
          <StatusPill status={run.status} />
        </div>
        <p className="num mt-1 text-xs text-muted">
          {run.runKey} · {run.org.name} · {run.org.threshold} of {run.org.approvers.length} approvers
        </p>
      </div>
      {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}

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
        <span className={`num flex h-6 w-6 items-center justify-center rounded-full border text-xs ${done ? "border-accent bg-accent text-paper" : "border-ink"}`}>
          {done ? "✓" : n}
        </span>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}
