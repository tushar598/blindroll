/**
 * Hand-typed payees ("Or add payees by hand" on the upload screen). The browser builds an ordinary
 * CSV with fixed columns; the server reads it with the fixed mapping below instead of asking the
 * AI (the columns are known, so no mapping call is needed). Rules and review are unchanged.
 */
import type { ColumnMapping } from "./mapping.ts";

export interface PayeeDraft {
  name: string;
  wallet: string;
  amount: string;
  memo: string;
}

export const PAYEE_CSV_HEADER = ["Name", "Wallet", "Amount (USDC)", "Memo"] as const;

/** The deterministic mapping for PAYEE_CSV_HEADER. Amounts are typed as 1,200.50 or 1200.50. */
export const PAYEE_MAPPING: ColumnMapping = {
  mapping: { name: "Name", chain: null, address: "Wallet", amount: "Amount (USDC)", currency: null, role: null, memo: "Memo", email: null },
  amount_format: { thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] },
};

/** True only when the file's header row is exactly the payee header, in order. */
export function isPayeeHeader(headers: readonly string[]): boolean {
  return headers.length === PAYEE_CSV_HEADER.length && PAYEE_CSV_HEADER.every((h, i) => headers[i] === h);
}

/** RFC 4180 field: quoted when it holds a comma, quote, line break or edge whitespace. */
function field(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildPayeeCsv(payees: readonly PayeeDraft[]): string {
  const lines = [PAYEE_CSV_HEADER.join(",")];
  for (const p of payees) lines.push([p.name, p.wallet, p.amount, p.memo].map(field).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
