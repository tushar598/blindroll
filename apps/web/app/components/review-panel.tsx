"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { RunFinding, RunRow, RunView } from "@/lib/client/types";

type Action = { kind: "remove"; rowNumber: number } | { kind: "override"; finding: RunFinding } | { kind: "edit"; row: RunRow };

export function ReviewPanel({ run, onChanged }: { run: RunView; onChanged: () => Promise<void> }) {
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimDays, setClaimDays] = useState(14);
  /** Test networks only: a claim window in minutes, to try "Reclaim unclaimed funds" without waiting days. */
  const [unit, setUnit] = useState<"days" | "minutes">("days");
  const [claimMinutes, setClaimMinutes] = useState(30);
  const editable = run.status === "review";
  const s = run.summary!;
  const byRow = new Map<number, RunFinding[]>();
  for (const f of run.findings) if (f.rowNumber !== null) byRow.set(f.rowNumber, [...(byRow.get(f.rowNumber) ?? []), f]);
  const runLevel = run.findings.filter((f) => f.rowNumber === null);

  async function post(path: string, json: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/runs/${run.runKey}/${path}`, { json });
      setAction(null);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-[#322E25]/15 grid grid-cols-2 divide-x divide-[#322E25]/10 sm:grid-cols-4">
        <Stat label="Recipients" value={String(s.rowCount)} />
        <Stat label="Total (USDC)" value={s.totalDisplay} />
        <Stat label="Errors" value={String(s.errorCount)} tone={s.errorCount > 0 ? "error" : undefined} hint="must be fixed or removed" />
        <Stat label="Warnings open" value={`${s.openWarningCount} of ${s.warningCount}`} tone={s.openWarningCount > 0 ? "warn" : undefined} hint="need a reason" />
      </div>

      {runLevel.map((f) => (
        <p key={f.id} className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{f.message}</p>
      ))}
      {error && <p className="border border-[#a3271f]/30 bg-[#f8e6e2] px-3 py-2 text-sm text-[#a3271f] font-mono">{error}</p>}

      <div className="border border-[#322E25]/15 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm font-mono">
          <thead className="border-b border-[#322E25]/10">
            <tr>
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#322E25]/60 font-normal">Row</th>
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#322E25]/60 font-normal">Recipient</th>
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#322E25]/60 font-normal">Wallet</th>
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#322E25]/60 font-normal text-right">Amount (USDC)</th>
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-[#322E25]/60 font-normal">Checks</th>
              {editable && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((r) => {
              const fs = byRow.get(r.rowNumber) ?? [];
              const worst = fs.some((f) => f.severity === "error") ? "error" : fs.some((f) => !f.overridden) ? "warn" : null;
              return (
                <tr key={r.rowNumber} className={`border-b border-[#322E25]/10 ${worst === "error" ? "bg-[#f8e6e2]/50" : worst === "warn" ? "bg-[#fbf0d6]/50" : ""}`}>
                  <td className="num px-4 py-3 align-top text-[#322E25]/60">{r.rowNumber}</td>
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium">{r.name || <span className="text-[#322E25]/40">no name</span>}</p>
                    <p className="text-xs text-[#322E25]/60">{[r.role, r.memo].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p className="num break-all text-xs">{r.address ?? r.raw.address ?? ""}</p>
                    <p className="text-xs text-[#322E25]/60">{r.chain ?? "unknown chain"}</p>
                  </td>
                  <td className="num px-4 py-3 text-right align-top">{r.amountDisplay ?? <span className="text-error">{r.raw.amount || "missing"}</span>}</td>
                  <td className="px-4 py-3 align-top">
                    {fs.length === 0 && <span className="text-[#0667DC] font-medium">✓ clean</span>}
                    <ul className="space-y-1.5">
                      {fs.map((f) => (
                        <li key={f.id}>
                          <span className={f.severity === "error" ? "text-error" : f.overridden ? "text-[#322E25]/60" : "text-warn"}>
                            {f.severity === "error" ? "Error" : f.overridden ? "Accepted" : "Warning"}: {f.message}
                          </span>
                          {f.overridden && <span className="block text-xs text-[#322E25]/60">Reason: {f.overrideReason}</span>}
                          {editable && f.severity === "warning" && !f.overridden && (
                            <button className="ml-2 text-xs font-mono font-medium text-[#0667DC] hover:underline" onClick={() => setAction({ kind: "override", finding: f })}>
                              Accept with a reason
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                  {editable && (
                    <td className="whitespace-nowrap px-4 py-3 text-right align-top">
                      <button className="text-xs font-mono font-medium text-[#0667DC] hover:underline" onClick={() => setAction({ kind: "edit", row: r })}>Edit</button>
                      <button className="ml-3 text-xs font-mono font-medium text-[#a3271f] hover:underline" onClick={() => setAction({ kind: "remove", rowNumber: r.rowNumber })}>Remove</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {action && (
        <ActionForm
          key={JSON.stringify(action.kind === "edit" ? ["e", action.row.rowNumber] : action.kind === "remove" ? ["r", action.rowNumber] : ["o", action.finding.id])}
          run={run}
          action={action}
          busy={busy}
          onCancel={() => setAction(null)}
          onSubmit={post}
        />
      )}

      {run.edits.length > 0 && (
        <details className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-4 text-sm font-mono">
          <summary className="cursor-pointer font-mono font-medium">Change log ({run.edits.length})</summary>
          <ul className="mt-3 space-y-1.5 text-[#322E25]/70">
            {run.edits.map((e, i) => (
              <li key={i}>
                <span className="text-xs font-mono break-all text-[#322E25]/70">{new Date(e.at).toLocaleString()}</span> · {e.by} ·{" "}
                {e.kind === "remove" ? `removed row ${e.rowNumber} (${e.reason})` : `set "${e.column}" of row ${e.rowNumber} to "${e.value}"`}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs font-mono break-all text-[#322E25]/60">Only the hash of this log goes into the report.</p>
        </details>
      )}

      {editable ? (
        <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-5 flex flex-wrap items-end justify-between gap-4 font-mono">
          <div className="text-sm leading-6">
            <p className="font-mono font-medium">Finalize</p>
            <p className="text-[#322E25]/70">
              Locks the table, builds the Merkle root and the report. After this the rows cannot change; a mistake needs a new run.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <label className="label" htmlFor="claim-days">Claim window ({unit})</label>
              {unit === "days" ? (
                <input id="claim-days" className="field num mt-1 w-28" type="number" min={1} max={365} value={claimDays} onChange={(e) => setClaimDays(Number(e.target.value))} />
              ) : (
                <input id="claim-days" className="field num mt-1 w-28" type="number" min={10} max={180} value={claimMinutes} onChange={(e) => setClaimMinutes(Number(e.target.value))} />
              )}
            </div>
            {run.network !== "mainnet" && (
              <div>
                <label className="label" htmlFor="claim-unit">Unit (minutes: testnet only)</label>
                <select id="claim-unit" className="field mt-1" value={unit} onChange={(e) => setUnit(e.target.value === "minutes" ? "minutes" : "days")}>
                  <option value="days">days</option>
                  <option value="minutes">minutes (to test reclaim)</option>
                </select>
              </div>
            )}
            <button className="btn" disabled={!s.canFinalize || busy} onClick={() => void post("finalize", unit === "minutes" ? { claimMinutes } : { claimDays })}>
              {busy ? "Working…" : "Finalize run"}
            </button>
          </div>
          {!s.canFinalize && (
            <p className="w-full text-sm text-[#322E25]/60">
              {s.errorCount > 0 ? `Fix or remove the ${s.errorCount} row(s) with errors first.` : s.openWarningCount > 0 ? `Accept the ${s.openWarningCount} open warning(s) with a reason first.` : "The run has no rows."}
            </p>
          )}
        </div>
      ) : (
        run.finalized && (
          <div className="border border-[#322E25]/15 bg-[#E1D7C0]/60 p-5 text-sm font-mono">
            <p className="font-mono font-medium">Finalized {new Date(run.finalized.finalizedAt).toLocaleString()}</p>
            <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Hash label="Merkle root" value={run.finalized.merkleRoot} />
              <Hash label="Report hash (sha256)" value={run.finalized.reportSha256} />
              <div>
                <dt className="label">Total</dt>
                <dd className="num mt-0.5">{run.finalized.totalDisplay} USDC to {run.finalized.recipientCount} recipients</dd>
              </div>
              <div>
                <dt className="label">Claims close</dt>
                <dd className="mt-0.5">{new Date(run.finalized.claimDeadlineMs).toLocaleString()}</dd>
              </div>
            </dl>
            <a className="mt-4 inline-block font-mono font-medium text-[#0667DC] hover:underline" href={`/runs/${run.runKey}/report`}>
              Verify the report and export
            </a>
            <span className="ml-2 text-[#322E25]/60">(the report is public: it holds no names, addresses or per-person amounts)</span>
          </div>
        )
      )}
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "error" | "warn"; hint?: string }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[#322E25]/60">{label}</p>
      <p className={`text-xl font-mono font-bold tabular-nums mt-1 ${tone === "error" ? "text-error" : tone === "warn" ? "text-warn" : ""}`}>{value}</p>
      {hint && tone && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="text-xs font-mono break-all text-[#322E25]/70 mt-0.5">{value}</dd>
    </div>
  );
}

function ActionForm({
  run, action, busy, onCancel, onSubmit,
}: {
  run: RunView;
  action: Action;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (path: string, json: unknown) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const m = run.mapping!.mapping;
  const editCols = action.kind === "edit" ? (([["address", m.address], ["amount", m.amount], ["currency", m.currency], ["chain", m.chain]] as const).filter((c): c is [typeof c[0], string] => c[1] !== null)) : [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    action.kind === "edit" ? Object.fromEntries(editCols.map(([f, col]) => [col, action.row.raw[f]])) : {},
  );

  async function submit() {
    if (action.kind === "remove") return onSubmit("edits", { kind: "remove", rowNumber: action.rowNumber, reason });
    if (action.kind === "override") return onSubmit("overrides", { findingId: action.finding.id, reason });
    // One logged edit per changed cell.
    const changed = editCols.filter(([f, col]) => values[col] !== action.row.raw[f]);
    for (const [, col] of changed) await onSubmit("edits", { kind: "set", rowNumber: action.row.rowNumber, column: col, value: values[col] });
    if (changed.length === 0) onCancel();
  }

  return (
    <div className="border-2 border-[#322E25] bg-[#E1D7C0]/60 p-5">
      {action.kind === "edit" ? (
        <>
          <p className="font-mono font-medium">Edit row {action.row.rowNumber}</p>
          <p className="mt-1 text-sm text-[#322E25]/60 font-mono">Changes are logged, and the whole table is checked again.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {editCols.map(([, col]) => (
              <div key={col}>
                <label className="label" htmlFor={`edit-${col}`}>{col}</label>
                <input id={`edit-${col}`} className="field num mt-1" value={values[col] ?? ""} onChange={(e) => setValues({ ...values, [col]: e.target.value })} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="font-mono font-medium">
            {action.kind === "remove" ? `Remove row ${action.rowNumber} from this run` : `Accept warning on row ${action.finding.rowNumber}: ${action.finding.message}`}
          </p>
          <label className="label mt-3 block" htmlFor="reason">Reason (logged; only its hash goes into the report)</label>
          <input id="reason" className="field mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
        </>
      )}
      <div className="mt-4 flex gap-3">
        <button className="btn" disabled={busy || (action.kind !== "edit" && reason.trim().length < 3)} onClick={() => void submit()}>
          {busy ? "Saving…" : action.kind === "remove" ? "Remove row" : action.kind === "override" ? "Accept warning" : "Save changes"}
        </button>
        <button className="btn-quiet" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
