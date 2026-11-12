/** Shapes returned by GET /api/runs/:runKey (see lib/server/runs.ts → getRun). */
export interface Mapping {
  mapping: Record<"name" | "chain" | "address" | "amount" | "currency" | "role" | "memo" | "email", string | null>;
  amount_format: { thousands_separator: string | null; decimal_separator: string | null; currency_symbols: string[] };
  notes?: string[];
}
export interface RunRow {
  rowNumber: number;
  name: string;
  email: string;
  role: string;
  memo: string;
  raw: { chain: string; address: string; amount: string; currency: string };
  chain: string | null;
  address: string | null;
  amount: string | null;
  amountDisplay: string | null;
}
export interface RunFinding {
  id: string;
  ruleId: string;
  severity: "error" | "warning";
  rowNumber: number | null;
  message: string;
  overridden: boolean;
  overrideReason?: string;
}
export interface ChainRun {
  creator: string;
  approvers: string[];
  threshold: number;
  approvals: string[];
  total_amount: string;
  funded_amount: string;
  claimed_amount: string;
  reclaimed_amount: string;
  claim_deadline_ms: number;
  refund_account: string;
  status: string;
}
export interface RunView {
  runKey: string;
  name: string;
  status: string;
  network: string;
  contractId: string;
  tokenId: string;
  org: { id: string; name: string; approvers: string[]; threshold: number; refundAccount: string };
  csvSha256: string;
  headers: string[];
  mappingSource: "ai" | "manual" | "fixed" | null;
  /** cached | live | ai_off | ai_failed | ai_limit (a sandbox AI limit was reached) | fixed */
  mappingNote: string | null;
  /** Judge sandbox run (1 of 1, limits apply). */
  sandbox: boolean;
  mapping: Mapping | null;
  aiLive: boolean;
  ai: { model: string; chatId: string; signatureVerified: boolean; attestationVerified: boolean } | null;
  rows: RunRow[];
  findings: RunFinding[];
  edits: Array<{ kind: "remove" | "set"; rowNumber: number; by: string; at: string; reason?: string; column?: string; value?: string }>;
  summary: { errorCount: number; warningCount: number; openWarningCount: number; canFinalize: boolean; currencyDefaulted: boolean; rowCount: number; totalDisplay: string } | null;
  finalized: { merkleRoot: string; reportSha256: string; tableSha256: string; totalAmount: string; totalDisplay: string; recipientCount: number; claimDeadlineMs: number; finalizedAt: string } | null;
  chain: ChainRun | null;
  createTx: string | null;
}
