"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { Mapping, RunView } from "@/lib/client/types";

const FIELDS = [
  ["address", "Wallet address", true],
  ["amount", "Amount", true],
  ["currency", "Currency", false],
  ["chain", "Chain", false],
  ["name", "Name", false],
  ["email", "Email", false],
  ["role", "Role", false],
  ["memo", "Memo", false],
] as const;
type Field = (typeof FIELDS)[number][0];

export function MappingPanel({ run, onChanged }: { run: RunView; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const canEdit = run.status === "needs_mapping" || run.status === "review";

  if (run.mapping === null || editing) {
    return (
      <ManualMappingForm
        run={run}
        onCancel={run.mapping ? () => setEditing(false) : undefined}
        onSaved={async () => {
          setEditing(false);
          await onChanged();
        }}
      />
    );
  }
  const m = run.mapping;
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="text-sm leading-6">
          {run.mappingSource === "ai" && run.ai ? (
            <>
              <p>
                Columns mapped by <span className="num">{run.ai.model}</span> on NEAR AI Cloud. It saw the header and up to 5 sample rows with emails masked.
                It only proposed this mapping; code read the amounts and ran the checks.
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                <li className={run.ai.signatureVerified ? "text-accent" : "text-error"}>
                  {run.ai.signatureVerified ? "✓ Response signature verified (signed inside the model's TEE)" : "✗ Response signature not verified"}
                </li>
                <li className="text-muted">– Attestation: stored, signer and nonce match; the Intel quote itself is not verified in this version</li>
              </ul>
            </>
          ) : (
            <p>Columns mapped by hand. No AI call backs this run, and the report will say so.</p>
          )}
        </div>
        {canEdit && (
          <button className="btn-quiet" onClick={() => setEditing(true)}>Change mapping</button>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-4">
        {FIELDS.map(([f, label]) => (
          <div key={f}>
            <dt className="label">{label}</dt>
            <dd className="mt-0.5">{m.mapping[f] ?? <span className="text-muted">{f === "chain" ? "from address format" : f === "currency" ? "none (USDC)" : "—"}</span>}</dd>
          </div>
        ))}
      </dl>
      {m.mapping.currency === null && (
        <p className="mt-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          This file has no currency column, so every amount is read as USDC. The report will note “currency defaulted to USDC”.
        </p>
      )}
    </div>
  );
}

function ManualMappingForm({ run, onSaved, onCancel }: { run: RunView; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const initial = run.mapping;
  const [cols, setCols] = useState<Record<Field, string>>(() => {
    const o = {} as Record<Field, string>;
    for (const [f] of FIELDS) o[f] = initial?.mapping[f] ?? "";
    return o;
  });
  const [thousands, setThousands] = useState(initial?.amount_format.thousands_separator ?? ",");
  const [decimal, setDecimal] = useState(initial?.amount_format.decimal_separator ?? ".");
  const [symbols, setSymbols] = useState((initial?.amount_format.currency_symbols ?? ["$"]).join(" "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const mapping: Mapping = {
      mapping: Object.fromEntries(FIELDS.map(([f]) => [f, cols[f] === "" ? null : cols[f]])) as Mapping["mapping"],
      amount_format: { thousands_separator: thousands === "" ? null : thousands, decimal_separator: decimal, currency_symbols: symbols.split(/\s+/).filter(Boolean) },
    };
    try {
      await api(`/api/runs/${run.runKey}/mapping`, { method: "PUT", json: mapping });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <p className="text-sm leading-6">
        {initial
          ? "Changing the mapping replaces the AI mapping and clears edits and overrides made so far."
          : run.aiLive
            ? "The AI mapping did not return a usable answer. Pick the column for each field."
            : "Live AI mapping is off, and this file has not been mapped before. Pick the column for each field."}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FIELDS.map(([f, label, required]) => (
          <div key={f}>
            <label className="label" htmlFor={`map-${f}`}>{label}{required ? " (required)" : ""}</label>
            <select id={`map-${f}`} className="field mt-1" value={cols[f]} onChange={(e) => setCols({ ...cols, [f]: e.target.value })}>
              <option value="">{required ? "Choose a column" : "Not in this file"}</option>
              {run.headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="map-thousands">Thousands separator</label>
          <select id="map-thousands" className="field mt-1" value={thousands} onChange={(e) => setThousands(e.target.value)}>
            <option value=",">Comma (1,200.50)</option>
            <option value=".">Dot (1.200,50)</option>
            <option value=" ">Space (1 200.50)</option>
            <option value="">None</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="map-decimal">Decimal separator</label>
          <select id="map-decimal" className="field mt-1" value={decimal} onChange={(e) => setDecimal(e.target.value)}>
            <option value=".">Dot</option>
            <option value=",">Comma</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="map-symbols">Currency symbols to ignore</label>
          <input id="map-symbols" className="field mt-1" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="$ USD" />
        </div>
      </div>
      {error && <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}
      <div className="mt-4 flex gap-3">
        <button className="btn" onClick={() => void save()} disabled={busy || cols.address === "" || cols.amount === ""}>
          {busy ? "Saving…" : "Use this mapping"}
        </button>
        {onCancel && <button className="btn-quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
