import { formatUsdc } from "../csv/amount.ts";
import type { Finding, NormalizedRow } from "../csv/normalize.ts";
import type { Chain } from "../merkle/leaf.ts";

export const RULES_VERSION = "rules-v1";
export const OUTLIER_MULTIPLE = 5n;

export interface RuleContext {
  /** Chains recipients can claim on in this deployment. MVP: near and evm. */
  supportedChains: readonly Chain[];
  /** Optional org cap per recipient, USDC base units. */
  perRecipientCap?: bigint;
  /** Optional org budget for the whole run, USDC base units. */
  runBudget?: bigint;
}

export const DEFAULT_RULE_CONTEXT: RuleContext = { supportedChains: ["near", "evm"] };

/**
 * Twice the median of the amounts (kept doubled so an even count needs no division).
 * Computed over every row with a parseable amount, as docs/05 specifies.
 */
export function doubledMedian(amounts: bigint[]): bigint | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! * 2n : sorted[mid - 1]! + sorted[mid]!;
}

/**
 * Deterministic anomaly rules over normalized rows (docs/05, Step 3).
 * R001–R003 and unknown-chain R011 come from normalization; this adds R004–R006 and R009–R011.
 * R007/R008 need run history and are not implemented (cut list in docs/12).
 */
export function runRules(rows: NormalizedRow[], ctx: RuleContext = DEFAULT_RULE_CONTEXT): Finding[] {
  const findings: Finding[] = [];

  // R011: valid chain, but not claimable in this deployment.
  for (const r of rows) {
    if (r.chain !== null && !ctx.supportedChains.includes(r.chain)) {
      findings.push({ ruleId: "R011_unsupported_chain", severity: "error", rowNumber: r.rowNumber, message: `Claims on ${r.chain} are not supported in this deployment` });
    }
  }

  // R004: same (chain, address) more than once. The first occurrence stays clean; later ones are flagged.
  const firstByAddress = new Map<string, number>();
  for (const r of rows) {
    if (r.chain === null || r.address === null) continue;
    const key = `${r.chain}|${r.address}`;
    const first = firstByAddress.get(key);
    if (first === undefined) firstByAddress.set(key, r.rowNumber);
    else findings.push({ ruleId: "R004_duplicate_address", severity: "error", rowNumber: r.rowNumber, message: `Same address as row ${first}` });
  }

  // R005: same name or email with a different address.
  const firstByIdentity = new Map<string, { rowNumber: number; address: string }>();
  for (const r of rows) {
    if (r.address === null) continue;
    const ids = [r.name && `name|${r.name.toLowerCase()}`, r.email && `email|${r.email.toLowerCase()}`].filter((x): x is string => !!x);
    let flagged = false;
    for (const id of ids) {
      const first = firstByIdentity.get(id);
      if (first === undefined) firstByIdentity.set(id, { rowNumber: r.rowNumber, address: r.address });
      else if (first.address !== r.address && !flagged) {
        flagged = true;
        findings.push({ ruleId: "R005_duplicate_identity", severity: "warning", rowNumber: r.rowNumber, message: `Same ${id.split("|")[0]} as row ${first.rowNumber} but a different address` });
      }
    }
  }

  // R006: amount > 5 × the run's median.
  const median2 = doubledMedian(rows.flatMap((r) => (r.amount === null ? [] : [r.amount])));
  if (median2 !== null) {
    for (const r of rows) {
      if (r.amount !== null && r.amount * 2n > OUTLIER_MULTIPLE * median2) {
        findings.push({ ruleId: "R006_outlier_vs_run", severity: "warning", rowNumber: r.rowNumber, message: `Amount ${formatUsdc(r.amount)} is more than 5 × the run median (${formatUsdc(median2 / 2n)})` });
      }
    }
  }

  // R009: above the per-recipient cap.
  if (ctx.perRecipientCap !== undefined) {
    for (const r of rows) {
      if (r.amount !== null && r.amount > ctx.perRecipientCap) {
        findings.push({ ruleId: "R009_over_cap", severity: "warning", rowNumber: r.rowNumber, message: `Amount ${formatUsdc(r.amount)} is above the per-recipient cap (${formatUsdc(ctx.perRecipientCap)})` });
      }
    }
  }

  // R010: run total above the budget.
  if (ctx.runBudget !== undefined) {
    const total = rows.reduce((s, r) => s + (r.amount ?? 0n), 0n);
    if (total > ctx.runBudget) {
      findings.push({ ruleId: "R010_budget_exceeded", severity: "error", rowNumber: null, message: `Run total ${formatUsdc(total)} is above the budget (${formatUsdc(ctx.runBudget)})` });
    }
  }

  return findings;
}

/** All findings for a run, ordered by row then rule ID (run-level findings last). */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => (a.rowNumber ?? Infinity) - (b.rowNumber ?? Infinity) || a.ruleId.localeCompare(b.ruleId));
}
