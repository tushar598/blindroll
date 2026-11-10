import { CHAINS, type Chain } from "../merkle/leaf.js";
import { inferChain, normalizeAddress } from "./address.js";
import { parseAmountCell } from "./amount.js";
import type { ColumnMapping } from "./mapping.js";
import type { ParsedCsv } from "./parse.js";

export type Severity = "error" | "warning";

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** Null for run-level findings. */
  rowNumber: number | null;
  message: string;
}

export interface NormalizedRow {
  rowNumber: number;
  name: string;
  email: string;
  role: string;
  memo: string;
  /** The cell texts as uploaded, for the review screen. */
  raw: { chain: string; address: string; amount: string; currency: string };
  /** Null when the chain could not be determined. */
  chain: Chain | null;
  /** Leaf-format address; null when invalid. */
  address: string | null;
  /** USDC base units; null when the amount cell is invalid. Set even if the currency is wrong, for the median. */
  amount: bigint | null;
  /** True when the currency is USD/USDC (or the file has no currency column). */
  currencyOk: boolean;
}

const USDC_NAMES = new Set(["USD", "USDC", "$"]);
const CHAIN_ALIASES: Record<string, Chain> = { near: "near", evm: "evm", ethereum: "evm", eth: "evm", solana: "solana", sol: "solana" };

export interface NormalizeResult {
  rows: NormalizedRow[];
  /** Per-row format findings: R001, R002, R003. */
  findings: Finding[];
}

/** Applies a validated column mapping. Pure and deterministic; the AI is not involved here. */
export function normalizeRows(csv: ParsedCsv, mapping: ColumnMapping): NormalizeResult {
  const m = mapping.mapping;
  const cell = (cells: Record<string, string>, col: string | null) => (col === null ? "" : (cells[col] ?? ""));
  const rows: NormalizedRow[] = [];
  const findings: Finding[] = [];

  for (const r of csv.rows) {
    const raw = {
      chain: cell(r.cells, m.chain),
      address: cell(r.cells, m.address),
      amount: cell(r.cells, m.amount),
      currency: cell(r.cells, m.currency),
    };

    let chain: Chain | null;
    if (m.chain !== null && raw.chain !== "") {
      chain = CHAIN_ALIASES[raw.chain.toLowerCase()] ?? null;
      if (chain === null) {
        findings.push({ ruleId: "R011_unsupported_chain", severity: "error", rowNumber: r.rowNumber, message: `Chain "${raw.chain}" is not supported (use ${CHAINS.join(", ")})` });
      }
    } else {
      chain = inferChain(raw.address);
    }
    const address = chain === null ? null : normalizeAddress(chain, raw.address);
    const chainKnownButBad = m.chain !== null && raw.chain !== "" && chain === null;
    if (address === null && !chainKnownButBad) {
      findings.push({
        ruleId: "R001_invalid_address",
        severity: "error",
        rowNumber: r.rowNumber,
        message: raw.address === "" ? "Address is missing" : `Address is not a valid ${chain ?? "NEAR, EVM or Solana"} address`,
      });
    }

    const parsed = parseAmountCell(raw.amount, mapping.amount_format);
    if (!parsed.ok) {
      findings.push({ ruleId: "R003_invalid_amount", severity: "error", rowNumber: r.rowNumber, message: `Invalid amount: ${parsed.reason}` });
    }

    const currencyOk = m.currency === null || USDC_NAMES.has(raw.currency.toUpperCase());
    if (!currencyOk) {
      findings.push({
        ruleId: "R002_unknown_currency",
        severity: "error",
        rowNumber: r.rowNumber,
        message: raw.currency === "" ? "Currency is missing (payouts are in USDC only)" : `Currency "${raw.currency}" is not USD or USDC (payouts are in USDC only)`,
      });
    }

    rows.push({
      rowNumber: r.rowNumber,
      name: cell(r.cells, m.name),
      email: cell(r.cells, m.email),
      role: cell(r.cells, m.role),
      memo: cell(r.cells, m.memo),
      raw,
      chain,
      address,
      amount: parsed.ok ? parsed.amount : null,
      currencyOk,
    });
  }
  return { rows, findings };
}
