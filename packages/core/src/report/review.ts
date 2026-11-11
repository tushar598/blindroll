import type { ColumnMapping } from "../csv/mapping.js";
import { type Finding, type NormalizedRow, normalizeRows } from "../csv/normalize.js";
import type { ParsedCsv } from "../csv/parse.js";
import { DEFAULT_RULE_CONTEXT, type RuleContext, runRules, sortFindings } from "../rules/index.js";
import { ValidationError } from "../validate.js";

/**
 * An approver's change to the uploaded table. Edits are applied to the raw cells, then the whole
 * table is normalized and checked again, so an edit can never bypass a rule.
 */
export type RowEdit =
  | { kind: "remove"; rowNumber: number; by: string; at: string; reason: string }
  | { kind: "set"; rowNumber: number; column: string; value: string; by: string; at: string };

/** Accepting one warning, with a reason. Keyed by rule and row, so it survives re-checks. */
export interface Override {
  ruleId: string;
  /** Null for run-level findings. */
  rowNumber: number | null;
  reason: string;
  by: string;
  at: string;
}

export interface ReviewedFinding extends Finding {
  /** `${ruleId}:${rowNumber ?? "run"}` */
  id: string;
  overridden: boolean;
  overrideReason?: string;
}

export interface Review {
  rows: NormalizedRow[];
  findings: ReviewedFinding[];
  errorCount: number;
  warningCount: number;
  openWarningCount: number;
  /** True when the file has no currency column, so every amount was taken as USDC. */
  currencyDefaulted: boolean;
  /** No errors, every warning overridden, at least one row. */
  canFinalize: boolean;
}

export function findingId(f: Pick<Finding, "ruleId" | "rowNumber">): string {
  return `${f.ruleId}:${f.rowNumber ?? "run"}`;
}

/** Applies edits in order. Unknown rows/columns are rejected so the log never holds no-op entries. */
export function applyEdits(csv: ParsedCsv, edits: readonly RowEdit[]): ParsedCsv {
  let rows = csv.rows.map((r) => ({ rowNumber: r.rowNumber, cells: { ...r.cells } }));
  for (const e of edits) {
    const row = rows.find((r) => r.rowNumber === e.rowNumber);
    if (!row) throw new ValidationError(`Row ${e.rowNumber} does not exist (or was removed)`);
    if (e.kind === "remove") {
      if (e.reason.trim() === "") throw new ValidationError("Removing a row needs a reason");
      rows = rows.filter((r) => r !== row);
    } else {
      if (!csv.headers.includes(e.column)) throw new ValidationError(`Column "${e.column}" is not in the file`);
      if (e.value.length > 500) throw new ValidationError("Cell value is too long");
      row.cells[e.column] = e.value.trim();
    }
  }
  return { ...csv, rows };
}

/** The single source of truth for the review screen and for finalize. Pure and deterministic. */
export function reviewRun(input: {
  csv: ParsedCsv;
  mapping: ColumnMapping;
  edits?: readonly RowEdit[];
  overrides?: readonly Override[];
  ruleContext?: RuleContext;
}): Review {
  const edited = applyEdits(input.csv, input.edits ?? []);
  const normalized = normalizeRows(edited, input.mapping);
  const all = sortFindings([...normalized.findings, ...runRules(normalized.rows, input.ruleContext ?? DEFAULT_RULE_CONTEXT)]);
  const overrides = new Map((input.overrides ?? []).map((o) => [findingId(o), o]));
  const findings: ReviewedFinding[] = all.map((f) => {
    const id = findingId(f);
    const o = f.severity === "warning" ? overrides.get(id) : undefined; // errors can never be overridden
    return { ...f, id, overridden: o !== undefined, ...(o ? { overrideReason: o.reason } : {}) };
  });
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning");
  const openWarningCount = warnings.filter((f) => !f.overridden).length;
  return {
    rows: normalized.rows,
    findings,
    errorCount,
    warningCount: warnings.length,
    openWarningCount,
    currencyDefaulted: input.mapping.mapping.currency === null,
    canFinalize: errorCount === 0 && openWarningCount === 0 && normalized.rows.length > 0,
  };
}
