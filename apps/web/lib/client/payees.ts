/**
 * "Add a payee" builds an ordinary CSV and uploads it through the same pipeline as a file
 * (column mapping → rules → review → finalize), so nothing typed here bypasses a check.
 */
export interface PayeeDraft {
  name: string;
  wallet: string;
  amount: string;
  memo: string;
}

export const PAYEE_CSV_HEADER = ["Name", "Wallet", "Amount (USDC)", "Memo"] as const;

/** RFC 4180 field: quoted when it holds a comma, quote, line break or edge whitespace. */
function field(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildPayeeCsv(payees: readonly PayeeDraft[]): string {
  const lines = [PAYEE_CSV_HEADER.join(",")];
  for (const p of payees) lines.push([p.name, p.wallet, p.amount, p.memo].map(field).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
