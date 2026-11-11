import type { AiMappingEvidence } from "../ai/client.js";
import type { Network } from "../config.js";
import { bytesToHex, sha256, utf8ToBytes } from "../hash.js";
import { LEAF_PREFIX } from "../merkle/leaf.js";
import { RULES_VERSION } from "../rules/index.js";
import { ValidationError, amountToString, assertNearAccountId } from "../validate.js";
import { type FinalizedRun, canonicalJson, sha256HexOfJson } from "./finalize.js";
import type { Review, RowEdit } from "./review.js";

export const REPORT_SCHEMA = "blindroll.report.v1";
export const NOTE_CURRENCY_DEFAULTED = "currency defaulted to USDC";

/** docs/05 step 5. Holds no per-person amounts, no addresses and no names: safe to publish. */
export interface AttestedReport {
  schema: typeof REPORT_SCHEMA;
  run_key: string;
  network: Network;
  contract_id: string;
  created_at: string;
  inputs: { csv_sha256: string; row_count: number };
  normalized: { table_sha256: string; recipient_count: number; total_amount: string; token: "usdc" };
  merkle: { root: string; leaf_format: string; node: "sha256-sorted-pair" };
  rules: {
    version: string;
    errors: number;
    warnings: number;
    results: Array<{ rule_id: string; row_hash: string | null; overridden: boolean; override_reason_sha256: string | null }>;
  };
  edits: { count: number; log_sha256: string };
  /** Plain-language notes about how the table was read, e.g. "currency defaulted to USDC". */
  notes: string[];
  /** null when the approver mapped the columns by hand (no AI call was used). */
  ai: {
    model: string;
    chat_id: string;
    request_sha256: string;
    response_sha256: string;
    /** null when NEAR AI Cloud had no signature for the call. */
    signature: { kind: string; algo: string; signing_address: string; signature: string } | null;
    /** True only when the signature text, kind and signer all verified at finalize time. */
    signature_verified: boolean;
    /** `verified` is false in the MVP: the Intel quote is not verified (docs/05 MVP fallback). */
    attestation: { nonce: string; verified: boolean; sha256: string };
  } | null;
  approval_policy: { approvers: string[]; threshold: number };
}

export interface BuildReportInput {
  finalized: FinalizedRun;
  review: Review;
  edits: readonly RowEdit[];
  network: Network;
  contractId: string;
  /** ISO 8601 UTC, seconds precision, set by the server at finalize time. */
  createdAt: string;
  csvSha256: string;
  /** Data rows in the uploaded file, including empty rows that were dropped. */
  csvRowCount: number;
  ai: AiMappingEvidence | null;
  approvers: string[];
  threshold: number;
}

const sha256HexOfText = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

export function buildReport(input: BuildReportInput): AttestedReport {
  const { finalized, review } = input;
  if (!review.canFinalize) throw new ValidationError("Cannot build a report for a run that is not ready to finalize");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.createdAt)) throw new ValidationError("created_at must be ISO 8601 UTC with seconds");
  assertNearAccountId(input.contractId, "contract_id");
  if (input.approvers.length < 1 || input.approvers.length > 10) throw new ValidationError("approvers must have 1 to 10 accounts");
  input.approvers.forEach((a) => assertNearAccountId(a, "approver"));
  if (new Set(input.approvers).size !== input.approvers.length) throw new ValidationError("approvers must be unique");
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > input.approvers.length) {
    throw new ValidationError("threshold must be between 1 and the number of approvers");
  }

  const rowHashByNumber = new Map(finalized.rows.map((r) => [r.rowNumber, r.rowHashHex]));
  const results = review.findings
    .map((f) => ({
      rule_id: f.ruleId,
      row_hash: f.rowNumber === null ? null : (rowHashByNumber.get(f.rowNumber) ?? null),
      overridden: f.overridden,
      override_reason_sha256: f.overrideReason === undefined ? null : sha256HexOfText(f.overrideReason),
    }))
    .sort((a, b) => a.rule_id.localeCompare(b.rule_id) || (a.row_hash ?? "").localeCompare(b.row_hash ?? ""));

  const ai = input.ai;
  return {
    schema: REPORT_SCHEMA,
    run_key: finalized.runKey,
    network: input.network,
    contract_id: input.contractId,
    created_at: input.createdAt,
    inputs: { csv_sha256: input.csvSha256, row_count: input.csvRowCount },
    normalized: {
      table_sha256: finalized.tableSha256,
      recipient_count: finalized.recipientCount,
      total_amount: amountToString(finalized.totalAmount),
      token: "usdc",
    },
    merkle: { root: finalized.merkleRoot, leaf_format: LEAF_PREFIX, node: "sha256-sorted-pair" },
    rules: { version: RULES_VERSION, errors: review.errorCount, warnings: review.warningCount, results },
    // The edit log itself holds addresses and reasons, so only its hash is published.
    edits: { count: input.edits.length, log_sha256: sha256HexOfJson(input.edits) },
    notes: review.currencyDefaulted ? [NOTE_CURRENCY_DEFAULTED] : [],
    ai:
      ai === null
        ? null
        : {
            model: ai.model,
            chat_id: ai.chatId,
            request_sha256: ai.requestSha256,
            response_sha256: ai.responseSha256,
            signature: ai.signature
              ? {
                  kind: ai.signature.signature_kind ?? "unknown",
                  algo: ai.signature.signing_algo,
                  signing_address: ai.signature.signing_address,
                  signature: ai.signature.signature,
                }
              : null,
            signature_verified: ai.signatureCheck.verified,
            attestation: { nonce: ai.nonce, verified: ai.attestationCheck.verified, sha256: sha256HexOfText(ai.attestationRaw) },
          },
    approval_policy: { approvers: [...input.approvers], threshold: input.threshold },
  };
}

/** The exact bytes that are hashed and served: RFC 8785 canonical JSON. */
export function reportCanonicalJson(report: AttestedReport): string {
  return canonicalJson(report);
}

/** `report_sha256`, lowercase hex: the `report_hash_hex` argument of create_run. */
export function reportSha256(report: AttestedReport): string {
  return sha256HexOfText(reportCanonicalJson(report));
}

/** Arguments of the contract's create_run, exactly as the wallet must send them (docs/04). */
export interface CreateRunArgs {
  run_key: string;
  approvers: string[];
  threshold: number;
  merkle_root_hex: string;
  report_hash_hex: string;
  recipient_count: number;
  total_amount: string;
  claim_deadline_ms: number;
  refund_account: string;
}

export function buildCreateRunArgs(input: { report: AttestedReport; claimDeadlineMs: number; refundAccount: string }): CreateRunArgs {
  assertNearAccountId(input.refundAccount, "refund_account");
  if (!Number.isSafeInteger(input.claimDeadlineMs) || input.claimDeadlineMs <= 0) throw new ValidationError("claim_deadline_ms must be a positive integer");
  const r = input.report;
  return {
    run_key: r.run_key,
    approvers: r.approval_policy.approvers,
    threshold: r.approval_policy.threshold,
    merkle_root_hex: r.merkle.root,
    report_hash_hex: reportSha256(r),
    recipient_count: r.normalized.recipient_count,
    total_amount: r.normalized.total_amount,
    claim_deadline_ms: input.claimDeadlineMs,
    refund_account: input.refundAccount,
  };
}
