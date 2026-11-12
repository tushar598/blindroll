import { randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  type AiClientConfig,
  type AiMappingEvidence,
  type AttestedReport,
  type ColumnMapping,
  type CreateRunArgs,
  type Override,
  type ParsedCsv,
  type Review,
  type RowEdit,
  ValidationError,
  buildCreateRunArgs,
  buildReport,
  finalizeRun,
  formatUsdc,
  parseCsv,
  randomSaltHex,
  reportCanonicalJson,
  reportSha256,
  requestColumnMapping,
  reviewRun,
  validateMapping,
} from "@blindroll/core";
import { HttpError } from "./auth";
import { CLAIM_WINDOW, DEFAULT_CLAIM_DAYS, MAX_RUN_ROWS, type ServerConfig } from "./config";
import { decrypt, decryptJson, encrypt, encryptJson } from "./crypto";
import { type Db, aiCalls, auditLog, orgApprovers, orgs, overrides, rowEdits, runRows, runs } from "./db";

type RunRecord = typeof runs.$inferSelect;
/** Evidence as stored: bytes become base64 so it survives JSON. */
type StoredEvidence = Omit<AiMappingEvidence, "responseBytes"> & { responseBase64: string };

const nowIso = () => new Date().toISOString();
const nowIsoSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export interface RunDeps {
  db: Db;
  config: ServerConfig;
  /** Present only when live AI calls are allowed (NEAR_AI_LIVE=1). */
  ai?: Pick<AiClientConfig, "apiKey" | "fetch">;
}

function audit(db: Db, actor: string, action: string, runId: number | null, data: object = {}) {
  db.insert(auditLog).values({ actor, action, runId, dataJson: JSON.stringify(data), createdAt: nowIso() }).run();
}

function orgPolicy(db: Db, orgId: string) {
  const org = db.select().from(orgs).where(eq(orgs.id, orgId)).get();
  if (!org) throw new HttpError(404, "org_not_found", "Organization not found");
  const approvers = db.select().from(orgApprovers).where(eq(orgApprovers.orgId, orgId)).orderBy(asc(orgApprovers.position)).all().map((a) => a.accountId);
  return { org, approvers };
}

/** Loads a run and checks that the account is an approver of its org. */
function loadRun(db: Db, runKey: string, accountId: string): RunRecord {
  const run = db.select().from(runs).where(eq(runs.runKey, runKey)).get();
  if (!run) throw new HttpError(404, "run_not_found", "Run not found");
  if (!orgPolicy(db, run.orgId).approvers.includes(accountId)) throw new HttpError(403, "forbidden", "You are not an approver of this run's organization");
  return run;
}

function runCsv(run: RunRecord): ParsedCsv {
  return parseCsv(new Uint8Array(decrypt(run.encCsv)));
}
function runEdits(db: Db, runId: number): RowEdit[] {
  return db.select().from(rowEdits).where(eq(rowEdits.runId, runId)).orderBy(asc(rowEdits.id)).all().map((e) => decryptJson<RowEdit>(e.encEdit));
}
function runOverrides(db: Db, runId: number): Override[] {
  return db.select().from(overrides).where(eq(overrides.runId, runId)).all().map((o) => ({
    ruleId: o.ruleId,
    rowNumber: o.rowNumber === -1 ? null : o.rowNumber,
    reason: decrypt(o.encReason).toString("utf8"),
    by: o.byAccount,
    at: o.createdAt,
  }));
}
function runEvidence(db: Db, run: RunRecord): AiMappingEvidence | null {
  if (run.mappingSource !== "ai" || run.aiCallId === null) return null;
  const call = db.select().from(aiCalls).where(eq(aiCalls.id, run.aiCallId)).get();
  if (!call) return null;
  const { responseBase64, ...rest } = decryptJson<StoredEvidence>(call.encEvidence);
  return { ...rest, responseBytes: new Uint8Array(Buffer.from(responseBase64, "base64")) };
}

function assertStatus(run: RunRecord, allowed: string[], what: string) {
  if (!allowed.includes(run.status)) throw new HttpError(409, "wrong_status", `${what} is not possible while the run is "${run.status}"`);
}

/**
 * Upload: parse, then get the column mapping. Order: cache by csv_sha256 → one live NEAR AI Cloud
 * call (only when NEAR_AI_LIVE=1) → otherwise the approver maps the columns by hand.
 */
export async function createRun(deps: RunDeps, input: { accountId: string; orgId: string; name: string; csvBytes: Uint8Array }) {
  const { db, config } = deps;
  const { approvers } = orgPolicy(db, input.orgId);
  if (!approvers.includes(input.accountId)) throw new HttpError(403, "forbidden", "You are not an approver of this organization");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new HttpError(400, "bad_request", "Run name must be 1 to 100 characters");
  const csv = parseCsv(input.csvBytes);
  if (csv.rows.length > MAX_RUN_ROWS) throw new HttpError(400, "too_many_rows", `A run can have at most ${MAX_RUN_ROWS} rows`);

  let mapping: ColumnMapping | null = null;
  let aiCallId: number | null = null;
  let aiNote: "cached" | "live" | "ai_off" | "ai_failed";
  const cached = db.select().from(aiCalls).where(eq(aiCalls.csvSha256, csv.csvSha256)).get();
  if (cached) {
    const ev = decryptJson<StoredEvidence & { mapping: ColumnMapping }>(cached.encEvidence);
    mapping = validateMapping(ev.mapping, csv.headers);
    aiCallId = cached.id;
    aiNote = "cached";
  } else if (deps.ai) {
    try {
      const r = await requestColumnMapping(csv, {
        baseUrl: config.aiBaseUrl,
        model: config.aiModel,
        apiKey: deps.ai.apiKey,
        fetch: deps.ai.fetch,
        nonce: randomBytes(32).toString("hex"),
      });
      const { responseBytes, ...rest } = r.evidence;
      const stored = { ...rest, responseBase64: Buffer.from(responseBytes).toString("base64"), mapping: r.mapping };
      aiCallId = db
        .insert(aiCalls)
        .values({
          csvSha256: csv.csvSha256,
          model: r.evidence.model,
          chatId: r.evidence.chatId,
          requestSha256: r.evidence.requestSha256,
          responseSha256: r.evidence.responseSha256,
          encEvidence: encryptJson(stored),
          attestationJson: r.evidence.attestationRaw,
          verified: r.evidence.signatureCheck.verified,
          createdAt: nowIso(),
        })
        .returning({ id: aiCalls.id })
        .get().id;
      mapping = r.mapping;
      aiNote = "live";
    } catch (err) {
      if (!(err instanceof ValidationError)) console.error("AI mapping call failed:", (err as Error).name); // never log bodies
      aiNote = "ai_failed";
    }
  } else {
    aiNote = "ai_off";
  }

  const runKey = `run-${randomBytes(9).toString("base64url")}`;
  const run = db
    .insert(runs)
    .values({
      runKey,
      orgId: input.orgId,
      name,
      status: mapping ? "review" : "needs_mapping",
      network: config.network,
      contractId: config.contractId,
      csvSha256: csv.csvSha256,
      encCsv: encrypt(input.csvBytes),
      encMapping: mapping ? encryptJson(mapping) : null,
      mappingSource: mapping ? "ai" : null,
      aiCallId,
      createdBy: input.accountId,
      createdAt: nowIso(),
    })
    .returning({ id: runs.id })
    .get();
  audit(db, input.accountId, "run_uploaded", run.id, { csv_sha256: csv.csvSha256, mapping: aiNote });
  return { runKey, mapping: aiNote };
}

/** Manual mapping fallback (docs/05): the approver picks the columns; code validates them. */
export function setManualMapping(deps: RunDeps, input: { accountId: string; runKey: string; mapping: unknown }) {
  const run = loadRun(deps.db, input.runKey, input.accountId);
  assertStatus(run, ["needs_mapping", "review"], "Changing the column mapping");
  const mapping = validateMapping(input.mapping, runCsv(run).headers);
  deps.db.update(runs).set({ encMapping: encryptJson(mapping), mappingSource: "manual", aiCallId: null, status: "review" }).where(eq(runs.id, run.id)).run();
  // Edits and overrides refer to the old reading of the table, so they are dropped.
  deps.db.delete(rowEdits).where(eq(rowEdits.runId, run.id)).run();
  deps.db.delete(overrides).where(eq(overrides.runId, run.id)).run();
  audit(deps.db, input.accountId, "mapping_set_manually", run.id);
}

function currentReview(db: Db, run: RunRecord): { csv: ParsedCsv; mapping: ColumnMapping; edits: RowEdit[]; review: Review } | null {
  if (!run.encMapping) return null;
  const csv = runCsv(run);
  const mapping = decryptJson<ColumnMapping>(run.encMapping);
  const edits = runEdits(db, run.id);
  return { csv, mapping, edits, review: reviewRun({ csv, mapping, edits, overrides: runOverrides(db, run.id) }) };
}

export function listRuns(db: Db, accountId: string) {
  const orgIds = db.select({ orgId: orgApprovers.orgId }).from(orgApprovers).where(eq(orgApprovers.accountId, accountId)).all().map((o) => o.orgId);
  return db
    .select()
    .from(runs)
    .orderBy(desc(runs.id))
    .all()
    .filter((r) => orgIds.includes(r.orgId))
    .map((r) => ({
      runKey: r.runKey, name: r.name, status: r.status, createdAt: r.createdAt, createdBy: r.createdBy,
      recipientCount: r.recipientCount, totalAmount: r.totalAmount,
    }));
}

/** Everything the review screen needs. Decrypted rows: approver session only. */
export function getRun(deps: RunDeps, input: { accountId: string; runKey: string }) {
  const { db } = deps;
  const run = loadRun(db, input.runKey, input.accountId);
  const { org, approvers } = orgPolicy(db, run.orgId);
  const cur = currentReview(db, run);
  const ai = run.aiCallId === null ? null : db.select().from(aiCalls).where(eq(aiCalls.id, run.aiCallId)).get();
  return {
    runKey: run.runKey,
    name: run.name,
    status: run.status,
    network: run.network,
    contractId: run.contractId,
    tokenId: deps.config.tokenId,
    org: { id: org.id, name: org.name, approvers, threshold: org.threshold, refundAccount: org.refundAccount },
    csvSha256: run.csvSha256,
    headers: runCsv(run).headers,
    mappingSource: run.mappingSource,
    mapping: cur?.mapping ?? null,
    aiLive: deps.ai !== undefined,
    ai: ai ? { model: ai.model, chatId: ai.chatId, signatureVerified: ai.verified, attestationVerified: false } : null,
    rows:
      cur?.review.rows.map((r) => ({
        rowNumber: r.rowNumber, name: r.name, email: r.email, role: r.role, memo: r.memo, raw: r.raw,
        chain: r.chain, address: r.address,
        amount: r.amount === null ? null : r.amount.toString(),
        amountDisplay: r.amount === null ? null : formatUsdc(r.amount),
      })) ?? [],
    findings: cur?.review.findings ?? [],
    edits: cur?.edits ?? [],
    summary: cur
      ? {
          errorCount: cur.review.errorCount, warningCount: cur.review.warningCount, openWarningCount: cur.review.openWarningCount,
          canFinalize: cur.review.canFinalize && run.status === "review", currencyDefaulted: cur.review.currencyDefaulted,
          rowCount: cur.review.rows.length,
          totalDisplay: formatUsdc(cur.review.rows.reduce((s, r) => s + (r.amount ?? 0n), 0n)),
        }
      : null,
    finalized:
      run.merkleRoot === null
        ? null
        : {
            merkleRoot: run.merkleRoot, reportSha256: run.reportSha256, tableSha256: run.tableSha256,
            totalAmount: run.totalAmount, totalDisplay: formatUsdc(BigInt(run.totalAmount!)),
            recipientCount: run.recipientCount, claimDeadlineMs: run.claimDeadlineMs, finalizedAt: run.finalizedAt,
          },
    chain: run.chainJson ? (JSON.parse(run.chainJson) as unknown) : null,
    createTx: run.createTx,
  };
}

/** Logs an edit after checking that the whole edit list still applies cleanly. */
export function addEdit(
  deps: RunDeps,
  input: { accountId: string; runKey: string; edit: { kind: "remove"; rowNumber: number; reason: string } | { kind: "set"; rowNumber: number; column: string; value: string } },
) {
  const { db } = deps;
  const run = loadRun(db, input.runKey, input.accountId);
  assertStatus(run, ["review"], "Editing rows");
  const cur = currentReview(db, run)!;
  const edit: RowEdit = { ...input.edit, by: input.accountId, at: nowIso() };
  reviewRun({ csv: cur.csv, mapping: cur.mapping, edits: [...cur.edits, edit] }); // throws ValidationError on a bad edit
  db.insert(rowEdits).values({ runId: run.id, byAccount: input.accountId, encEdit: encryptJson(edit), createdAt: edit.at }).run();
  audit(db, input.accountId, edit.kind === "remove" ? "row_removed" : "row_edited", run.id, { row: edit.rowNumber });
}

/** Accepts one open warning with a reason. Errors cannot be overridden. */
export function addOverride(deps: RunDeps, input: { accountId: string; runKey: string; findingId: string; reason: string }) {
  const { db } = deps;
  const run = loadRun(db, input.runKey, input.accountId);
  assertStatus(run, ["review"], "Overriding a warning");
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new HttpError(400, "bad_request", "The override reason must be 3 to 500 characters");
  const finding = currentReview(db, run)!.review.findings.find((f) => f.id === input.findingId);
  if (!finding) throw new HttpError(404, "finding_not_found", "That finding does not exist (the table may have changed)");
  if (finding.severity !== "warning") throw new HttpError(400, "not_overridable", "Errors cannot be overridden; fix or remove the row");
  const rowNumber = finding.rowNumber ?? -1;
  db.delete(overrides).where(and(eq(overrides.runId, run.id), eq(overrides.ruleId, finding.ruleId), eq(overrides.rowNumber, rowNumber))).run();
  db.insert(overrides).values({ runId: run.id, ruleId: finding.ruleId, rowNumber, byAccount: input.accountId, encReason: encrypt(reason), createdAt: nowIso() }).run();
  audit(db, input.accountId, "warning_overridden", run.id, { rule_id: finding.ruleId });
}

/** Locks the table: salts, leaves, Merkle root, proofs and the attested report (docs/05 step 5). */
export function finalize(deps: RunDeps, input: { accountId: string; runKey: string; claimDays?: number; claimMinutes?: number }) {
  const { db, config } = deps;
  const run = loadRun(db, input.runKey, input.accountId);
  assertStatus(run, ["review"], "Finalizing");
  let windowMs: number;
  if (input.claimMinutes !== undefined) {
    // A window in minutes exists only to try the reclaim step on a test network.
    if (config.network === "mainnet") throw new HttpError(400, "bad_request", "A claim window in minutes is only available on test networks");
    const m = input.claimMinutes;
    if (!Number.isInteger(m) || m < CLAIM_WINDOW.minMinutes || m > CLAIM_WINDOW.maxMinutes) throw new HttpError(400, "bad_request", `The claim window must be ${CLAIM_WINDOW.minMinutes} to ${CLAIM_WINDOW.maxMinutes} minutes`);
    windowMs = m * 60 * 1000;
  } else {
    const days = input.claimDays ?? DEFAULT_CLAIM_DAYS;
    if (!Number.isInteger(days) || days < CLAIM_WINDOW.minDays || days > CLAIM_WINDOW.maxDays) throw new HttpError(400, "bad_request", "The claim window must be 1 to 365 days");
    windowMs = days * 24 * 60 * 60 * 1000;
  }
  const cur = currentReview(db, run)!;
  const { org, approvers } = orgPolicy(db, run.orgId);

  const salts = new Map(cur.review.rows.map((r) => [r.rowNumber, randomSaltHex()]));
  const fin = finalizeRun({ runKey: run.runKey, review: cur.review, salts }); // throws while errors or open warnings remain
  const report = buildReport({
    finalized: fin,
    review: cur.review,
    edits: cur.edits,
    network: config.network,
    contractId: config.contractId,
    createdAt: nowIsoSeconds(),
    csvSha256: run.csvSha256,
    csvRowCount: cur.csv.rows.length + cur.csv.droppedEmptyRows.length,
    ai: runEvidence(db, run),
    approvers,
    threshold: org.threshold,
  });
  const reportHash = reportSha256(report);
  const claimDeadlineMs = Date.now() + windowMs;
  const byNumber = new Map(cur.review.rows.map((r) => [r.rowNumber, r]));

  db.transaction((tx) => {
    tx.delete(runRows).where(eq(runRows.runId, run.id)).run();
    fin.rows.forEach((r, i) => {
      const src = byNumber.get(r.rowNumber)!;
      tx.insert(runRows)
        .values({
          runId: run.id,
          rowIndex: i,
          encPayload: encryptJson({ name: src.name, email: src.email, role: src.role, memo: src.memo, rowNumber: r.rowNumber }),
          chain: r.leaf.chain,
          address: r.leaf.address,
          amount: r.leaf.amount.toString(),
          saltHex: r.leaf.saltHex,
          leafHash: r.leafHashHex,
          proofJson: JSON.stringify(r.proof),
          status: "pending",
        })
        .run();
    });
    tx.update(runs)
      .set({
        status: "finalized",
        tableSha256: fin.tableSha256,
        merkleRoot: fin.merkleRoot,
        reportSha256: reportHash,
        reportJson: reportCanonicalJson(report),
        totalAmount: fin.totalAmount.toString(),
        recipientCount: fin.recipientCount,
        claimDeadlineMs,
        finalizedAt: nowIso(),
      })
      .where(eq(runs.id, run.id))
      .run();
  });
  audit(db, input.accountId, "run_finalized", run.id, { merkle_root: fin.merkleRoot, report_sha256: reportHash });
  return { merkleRoot: fin.merkleRoot, reportHash, totalAmount: fin.totalAmount.toString(), recipientCount: fin.recipientCount };
}

/** Per-recipient part of the create_run storage charge (docs/04): 0.00225 NEAR, in yoctoNEAR. */
const PER_RECIPIENT_YOCTO = 2_250_000_000_000_000_000_000n;
/** Covers the run record itself; the contract refunds whatever it does not use. */
const RUN_STORAGE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

/** Exact create_run arguments plus the deposit to attach. The approver's wallet signs this. */
export function getCreateArgs(deps: RunDeps, input: { accountId: string; runKey: string }): { contractId: string; args: CreateRunArgs; depositYocto: string } {
  const run = loadRun(deps.db, input.runKey, input.accountId);
  if (!run.reportJson || run.claimDeadlineMs === null) throw new HttpError(409, "not_finalized", "Finalize the run first");
  const { org } = orgPolicy(deps.db, run.orgId);
  const report = JSON.parse(run.reportJson) as AttestedReport;
  const args = buildCreateRunArgs({ report, claimDeadlineMs: run.claimDeadlineMs, refundAccount: org.refundAccount });
  if (args.report_hash_hex !== run.reportSha256) throw new HttpError(500, "report_mismatch", "The stored report does not match its hash");
  return { contractId: run.contractId, args, depositYocto: (RUN_STORAGE_YOCTO + PER_RECIPIENT_YOCTO * BigInt(args.recipient_count)).toString() };
}

interface ChainRun {
  run_key: string; creator: string; approvers: string[]; threshold: number; approvals: string[];
  merkle_root: string; report_hash: string; recipient_count: number; total_amount: string; funded_amount: string;
  claimed_amount: string; reclaimed_amount: string; claim_deadline_ms: number; refund_account: string; status: string;
}

/**
 * Reads the run from the contract and stores it. Refuses to adopt an on-chain run whose root or
 * report hash differs from ours (someone else could have created the same run_key first).
 */
export async function syncRun(
  deps: RunDeps,
  input: { accountId: string; runKey: string; createTx?: string },
  view: (contractId: string, method: string, args: object) => Promise<unknown>,
) {
  const { db } = deps;
  const run = loadRun(db, input.runKey, input.accountId);
  if (run.merkleRoot === null) throw new HttpError(409, "not_finalized", "Finalize the run first");
  const chain = (await view(run.contractId, "get_run", { run_key: run.runKey })) as ChainRun | null;
  if (chain === null) return { onChain: false as const, status: run.status };
  if (chain.merkle_root !== run.merkleRoot || chain.report_hash !== run.reportSha256) {
    throw new HttpError(409, "chain_mismatch", "A run with this key exists on-chain with a different Merkle root or report hash");
  }
  const status = chain.status.toLowerCase();
  const createTx = input.createTx && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.createTx) ? input.createTx : run.createTx;
  db.update(runs).set({ status, chainJson: JSON.stringify(chain), createTx }).where(eq(runs.id, run.id)).run();
  if (status !== run.status) audit(db, input.accountId, "run_synced", run.id, { status });
  return { onChain: true as const, status, chain };
}

/** Public: the canonical report bytes (docs/09 "Report (public read)"). Null until finalized. */
export function getReportJson(db: Db, runKey: string): string | null {
  return db.select({ reportJson: runs.reportJson }).from(runs).where(eq(runs.runKey, runKey)).get()?.reportJson ?? null;
}

/**
 * Public: the raw NEAR AI Cloud attestation stored for a finalized run, exactly as received.
 * It holds no payroll data (NEAR AI's quote, event log, signing key and our nonce). Its sha256 is
 * `ai.attestation.sha256` in the report, so a browser can check it was not swapped (docs/05).
 */
export function getAttestationText(db: Db, runKey: string): string | null {
  const run = db.select({ reportJson: runs.reportJson, aiCallId: runs.aiCallId }).from(runs).where(eq(runs.runKey, runKey)).get();
  if (!run?.reportJson || run.aiCallId === null) return null;
  return db.select({ a: aiCalls.attestationJson }).from(aiCalls).where(eq(aiCalls.id, run.aiCallId)).get()?.a ?? null;
}
