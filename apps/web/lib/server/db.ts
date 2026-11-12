import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { findRepoRoot } from "@blindroll/core/env";
import { DEMO_ORG, demoOrgApprovers, demoOrgRefundAccount } from "./config";

// Schema: docs/09. Amounts are decimal strings of USDC base units (never floats).

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  threshold: integer("threshold").notNull(),
  refundAccount: text("refund_account").notNull(),
  createdAt: text("created_at").notNull(),
});

export const orgApprovers = sqliteTable(
  "org_approvers",
  { orgId: text("org_id").notNull(), accountId: text("account_id").notNull(), position: integer("position").notNull() },
  (t) => [uniqueIndex("org_approvers_unique").on(t.orgId, t.accountId)],
);

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runKey: text("run_key").notNull().unique(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  /** needs_mapping | review | finalized | draft | approved | active | closed | cancelled */
  status: text("status").notNull(),
  network: text("network").notNull(),
  contractId: text("contract_id").notNull(),
  csvSha256: text("csv_sha256").notNull(),
  /** AES-256-GCM of the uploaded CSV bytes. */
  encCsv: text("enc_csv").notNull(),
  /** AES-256-GCM JSON of the validated column mapping; null until mapped. */
  encMapping: text("enc_mapping"),
  /** ai | manual | fixed (hand-typed payees, fixed columns, no AI call) */
  mappingSource: text("mapping_source"),
  aiCallId: integer("ai_call_id"),
  tableSha256: text("table_sha256"),
  merkleRoot: text("merkle_root"),
  reportSha256: text("report_sha256"),
  /** Canonical report JSON (public: holds no amounts per person, addresses or names). */
  reportJson: text("report_json"),
  totalAmount: text("total_amount"),
  recipientCount: integer("recipient_count"),
  claimDeadlineMs: integer("claim_deadline_ms"),
  createTx: text("create_tx"),
  /** Last on-chain view of the run (JSON), written by sync. */
  chainJson: text("chain_json"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  finalizedAt: text("finalized_at"),
});

export const runRows = sqliteTable("run_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  rowIndex: integer("row_index").notNull(),
  /** AES-256-GCM JSON: name, email, role, memo. */
  encPayload: text("enc_payload").notNull(),
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  amount: text("amount").notNull(),
  saltHex: text("salt_hex").notNull(),
  leafHash: text("leaf_hash").notNull(),
  proofJson: text("proof_json").notNull(),
  /** pending | claimed | refunded | reopened | unclaimed */
  status: text("status").notNull(),
});

/** Ordered edit log of a run (cell edits and row removals), encrypted: it holds addresses and reasons. */
export const rowEdits = sqliteTable("row_edits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  byAccount: text("by_account").notNull(),
  encEdit: text("enc_edit").notNull(),
  createdAt: text("created_at").notNull(),
});

export const overrides = sqliteTable(
  "overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    ruleId: text("rule_id").notNull(),
    /** -1 for run-level findings. */
    rowNumber: integer("row_number").notNull(),
    byAccount: text("by_account").notNull(),
    encReason: text("enc_reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("overrides_unique").on(t.runId, t.ruleId, t.rowNumber)],
);

export const aiCalls = sqliteTable("ai_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Cache key: the same CSV is never sent to the model twice (docs/05). */
  csvSha256: text("csv_sha256").notNull().unique(),
  model: text("model").notNull(),
  chatId: text("chat_id").notNull(),
  requestSha256: text("request_sha256").notNull(),
  responseSha256: text("response_sha256").notNull(),
  /** AES-256-GCM JSON of the full evidence (request body, response bytes, signature, checks). */
  encEvidence: text("enc_evidence").notNull(),
  /** Raw preflight attestation text, as received (public data). */
  attestationJson: text("attestation_json").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** One row per prepared claim. The signed message and payout target are fixed at prepare time. */
export const claims = sqliteTable("claims", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull(),
  rowId: integer("row_id").notNull(),
  /** near-usdc | oneclick:<chain>:<symbol> */
  optionId: text("option_id").notNull(),
  /** near_ft | oneclick */
  payoutKind: text("payout_kind").notNull(),
  payoutTarget: text("payout_target").notNull(),
  destinationAsset: text("destination_asset").notNull(),
  destinationAddress: text("destination_address").notNull(),
  /** EVM claims only: the signed expiry and the exact message text. */
  expiresAtMs: integer("expires_at_ms"),
  message: text("message"),
  claimTx: text("claim_tx"),
  /** prepared | submitted | confirmed | failed */
  status: text("status").notNull(),
  error: text("error"),
  simulated: integer("simulated", { mode: "boolean" }).notNull(),
  /** oneclick claims only: delivered_simulated | refunding | refunded_simulated | reopened */
  payoutStatus: text("payout_status"),
  /** JSON of the dry quote shown to the recipient at prepare time (estimates). */
  quoteJson: text("quote_json"),
  /** The real token transfer that returned the USDC to the contract. */
  refundTx: text("refund_tx"),
  reopenTx: text("reopen_tx"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  runId: integer("run_id"),
  dataJson: text("data_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const nonces = sqliteTable("nonces", {
  nonce: text("nonce").primaryKey(),
  purpose: text("purpose").notNull(),
  expiresAt: integer("expires_at").notNull(),
  used: integer("used", { mode: "boolean" }).notNull(),
});

const DDL = `
CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, threshold INTEGER NOT NULL, refund_account TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS org_approvers (org_id TEXT NOT NULL, account_id TEXT NOT NULL, position INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS org_approvers_unique ON org_approvers (org_id, account_id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  network TEXT NOT NULL, contract_id TEXT NOT NULL, csv_sha256 TEXT NOT NULL, enc_csv TEXT NOT NULL, enc_mapping TEXT, mapping_source TEXT,
  ai_call_id INTEGER, table_sha256 TEXT, merkle_root TEXT, report_sha256 TEXT, report_json TEXT, total_amount TEXT, recipient_count INTEGER,
  claim_deadline_ms INTEGER, create_tx TEXT, chain_json TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, finalized_at TEXT);
CREATE TABLE IF NOT EXISTS run_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, row_index INTEGER NOT NULL, enc_payload TEXT NOT NULL, chain TEXT NOT NULL,
  address TEXT NOT NULL, amount TEXT NOT NULL, salt_hex TEXT NOT NULL, leaf_hash TEXT NOT NULL, proof_json TEXT NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS run_rows_lookup ON run_rows (run_id, chain, address);
CREATE TABLE IF NOT EXISTS row_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, by_account TEXT NOT NULL, enc_edit TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, rule_id TEXT NOT NULL, row_number INTEGER NOT NULL, by_account TEXT NOT NULL, enc_reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS overrides_unique ON overrides (run_id, rule_id, row_number);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, csv_sha256 TEXT NOT NULL UNIQUE, model TEXT NOT NULL, chat_id TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL, enc_evidence TEXT NOT NULL, attestation_json TEXT NOT NULL, verified INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, row_id INTEGER NOT NULL, option_id TEXT NOT NULL, payout_kind TEXT NOT NULL,
  payout_target TEXT NOT NULL, destination_asset TEXT NOT NULL, destination_address TEXT NOT NULL, expires_at_ms INTEGER, message TEXT,
  claim_tx TEXT, status TEXT NOT NULL, error TEXT, simulated INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS claims_row ON claims (row_id);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, run_id INTEGER, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL);
`;

export type Db = ReturnType<typeof openDb>;

/** Opens (and creates if needed) a database and seeds the demo org. `:memory:` is used by tests. */
export function openDb(file: string) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  // Columns added after the first version of a table (no migration tool; see docs/09).
  const addColumn = (table: string, column: string, type: string) => {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  for (const c of ["payout_status", "quote_json", "refund_tx", "reopen_tx"]) addColumn("claims", c, "TEXT");
  const now = new Date().toISOString();
  sqlite.prepare("INSERT OR IGNORE INTO orgs (id, name, threshold, refund_account, created_at) VALUES (?, ?, ?, ?, ?)").run(
    DEMO_ORG.id, DEMO_ORG.name, DEMO_ORG.threshold, demoOrgRefundAccount(), now,
  );
  // The refund account follows the configuration too (it applies to runs created on-chain afterwards).
  sqlite.prepare("UPDATE orgs SET refund_account = ? WHERE id = ? AND refund_account <> ?").run(demoOrgRefundAccount(), DEMO_ORG.id, demoOrgRefundAccount());
  // The seeded approver list follows the configuration (it is replaced, not only added to).
  const approvers = demoOrgApprovers();
  const current = (sqlite.prepare("SELECT account_id FROM org_approvers WHERE org_id = ? ORDER BY position").all(DEMO_ORG.id) as Array<{ account_id: string }>).map((r) => r.account_id);
  if (current.join(",") !== approvers.join(",")) {
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM org_approvers WHERE org_id = ?").run(DEMO_ORG.id);
      approvers.forEach((a, i) => sqlite.prepare("INSERT INTO org_approvers (org_id, account_id, position) VALUES (?, ?, ?)").run(DEMO_ORG.id, a, i));
    })();
  }
  return drizzle(sqlite);
}

const globalForDb = globalThis as unknown as { __blindrollDb?: Db };

/** The app database: <repo root>/data/blindroll.sqlite (git-ignored). One connection per process. */
export function db(): Db {
  // BLINDROLL_DB_FILE (optional) points tests and smoke runs at another file.
  globalForDb.__blindrollDb ??= openDb(process.env.BLINDROLL_DB_FILE || join(findRepoRoot(), "data", "blindroll.sqlite"));
  return globalForDb.__blindrollDb;
}
