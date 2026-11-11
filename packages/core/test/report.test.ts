import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AiMappingEvidence,
  type Override,
  type RowEdit,
  buildCreateRunArgs,
  buildReport,
  canonicalJson,
  checkPreflightAttestation,
  finalizeRun,
  parseCsv,
  parseMappingContent,
  randomSaltHex,
  reportCanonicalJson,
  reportSha256,
  reviewRun,
  verifyAiSignature,
  verifyProof,
} from "../src/index.js";
import { hexToBytes } from "../src/hash.js";

const csvBytes = new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-messy.csv", import.meta.url)));
const csv = parseCsv(csvBytes);
const dir = new URL("../test-vectors/ai/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("mapping-fixture.json", dir), "utf8"));
const attestationRaw = readFileSync(new URL("attestation-preflight.json", dir), "utf8");
const responseBytes = new Uint8Array(Buffer.from(fixture.response_body_base64, "base64"));
const mapping = parseMappingContent(JSON.parse(new TextDecoder().decode(responseBytes)).choices[0].message.content, csv.headers);

const who = { by: "tushar1962005.testnet", at: "2026-11-11T10:00:00Z" };
const edits: RowEdit[] = [
  { kind: "remove", rowNumber: 6, reason: "duplicate row", ...who },
  { kind: "remove", rowNumber: 8, reason: "paid in EUR elsewhere", ...who },
  { kind: "remove", rowNumber: 9, reason: "address invalid, will go in a correction run", ...who },
];
const overrides: Override[] = [{ ruleId: "R006_outlier_vs_run", rowNumber: 7, reason: "Community lead, quarterly grant", ...who }];
const salts = new Map(csv.rows.map((r) => [r.rowNumber, (r.rowNumber.toString(16).padStart(2, "0")).repeat(16)]));
const RUN_KEY = "demo-run-1";

async function evidence(): Promise<AiMappingEvidence> {
  const requestBytes = new TextEncoder().encode(fixture.request_body);
  const signature = fixture.signature_response;
  return {
    model: fixture.model, chatId: fixture.chat_id, nonce: fixture.nonce,
    requestBody: fixture.request_body, responseBytes,
    requestSha256: fixture.request_sha256, responseSha256: fixture.response_sha256,
    signature,
    signatureCheck: await verifyAiSignature({ model: fixture.model, requestBytes, responseBytes, signature }),
    attestationRaw,
    attestationCheck: checkPreflightAttestation({ attestation: JSON.parse(attestationRaw), nonce: fixture.nonce, signature }),
  };
}

describe("reviewRun on the sample CSV", () => {
  it("finds the documented problems before any edit", () => {
    const r = reviewRun({ csv, mapping });
    expect(r.findings.map((f) => f.id)).toEqual([
      "R004_duplicate_address:6", "R006_outlier_vs_run:7", "R002_unknown_currency:8", "R001_invalid_address:9",
    ]);
    expect(r).toMatchObject({ errorCount: 3, warningCount: 1, openWarningCount: 1, canFinalize: false, currencyDefaulted: false });
  });
  it("is ready after removing the bad rows and overriding the warning", () => {
    const r = reviewRun({ csv, mapping, edits, overrides });
    expect(r).toMatchObject({ errorCount: 0, warningCount: 1, openWarningCount: 0, canFinalize: true });
    expect(r.rows).toHaveLength(6);
  });
  it("a cell edit is re-checked by the rules, and errors cannot be overridden", () => {
    const fix: RowEdit = { kind: "set", rowNumber: 8, column: "currency", value: "USDC", ...who };
    expect(reviewRun({ csv, mapping, edits: [fix] }).findings.some((f) => f.id === "R002_unknown_currency:8")).toBe(false);
    const sneaky: Override[] = [{ ruleId: "R001_invalid_address", rowNumber: 9, reason: "trust me", ...who }];
    expect(reviewRun({ csv, mapping, overrides: sneaky }).findings.find((f) => f.id === "R001_invalid_address:9")!.overridden).toBe(false);
  });
  it("rejects edits to unknown rows or columns and removals without a reason", () => {
    expect(() => reviewRun({ csv, mapping, edits: [{ kind: "remove", rowNumber: 99, reason: "x", ...who }] })).toThrow();
    expect(() => reviewRun({ csv, mapping, edits: [{ kind: "remove", rowNumber: 6, reason: " ", ...who }] })).toThrow();
    expect(() => reviewRun({ csv, mapping, edits: [{ kind: "set", rowNumber: 6, column: "Nope", value: "1", ...who }] })).toThrow();
    expect(() => reviewRun({ csv, mapping, edits: [edits[0]!, { kind: "set", rowNumber: 6, column: "Role", value: "x", ...who }] })).toThrow();
  });
  it("notes a defaulted currency when the mapping has no currency column", () => {
    const noCurrency = { ...mapping, mapping: { ...mapping.mapping, currency: null } };
    expect(reviewRun({ csv, mapping: noCurrency }).currencyDefaulted).toBe(true);
  });
});

describe("finalizeRun", () => {
  const review = reviewRun({ csv, mapping, edits, overrides });
  const fin = finalizeRun({ runKey: RUN_KEY, review, salts });
  it("matches the documented clean table", () => {
    expect(fin.recipientCount).toBe(6);
    expect(fin.totalAmount).toBe(14600500000n);
    expect(fin.rows.filter((r) => r.leaf.chain === "evm")).toHaveLength(4);
    expect(fin.rows.filter((r) => r.leaf.chain === "near")).toHaveLength(2);
  });
  it("gives every row a proof that verifies against the root, in leaf-hash order", () => {
    for (const r of fin.rows) expect(verifyProof(hexToBytes(r.leafHashHex), r.proof, fin.merkleRoot)).toBe(true);
    const hashes = fin.rows.map((r) => r.leafHashHex);
    expect([...hashes].sort()).toEqual(hashes);
  });
  it("is deterministic for the same salts and changes with the run key", () => {
    expect(finalizeRun({ runKey: RUN_KEY, review, salts }).merkleRoot).toBe(fin.merkleRoot);
    const other = finalizeRun({ runKey: "demo-run-2", review, salts });
    expect(other.merkleRoot).not.toBe(fin.merkleRoot);
    expect(other.tableSha256).not.toBe(""); // table hash order follows leaf hashes, so it may differ too
  });
  it("refuses with errors, open warnings or a missing salt", () => {
    expect(() => finalizeRun({ runKey: RUN_KEY, review: reviewRun({ csv, mapping }), salts })).toThrow("error(s)");
    expect(() => finalizeRun({ runKey: RUN_KEY, review: reviewRun({ csv, mapping, edits }), salts })).toThrow("warning(s)");
    expect(() => finalizeRun({ runKey: RUN_KEY, review, salts: new Map() })).toThrow("salt");
  });
  it("randomSaltHex returns 32 lowercase hex chars", () => {
    expect(randomSaltHex()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSaltHex()).not.toBe(randomSaltHex());
  });
});

describe("buildReport", () => {
  const review = reviewRun({ csv, mapping, edits, overrides });
  const fin = finalizeRun({ runKey: RUN_KEY, review, salts });
  const base = {
    finalized: fin, review, edits, network: "testnet" as const, contractId: "blindroll.blindroll-dev.testnet",
    createdAt: "2026-11-11T10:00:00Z", csvSha256: csv.csvSha256, csvRowCount: csv.rows.length + csv.droppedEmptyRows.length,
    approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2,
  };

  it("builds the spec's report with the real AI evidence", async () => {
    const report = buildReport({ ...base, ai: await evidence() });
    expect(report).toMatchObject({
      schema: "blindroll.report.v1", run_key: RUN_KEY, network: "testnet",
      inputs: { csv_sha256: csv.csvSha256, row_count: 10 },
      normalized: { recipient_count: 6, total_amount: "14600500000", token: "usdc", table_sha256: fin.tableSha256 },
      merkle: { root: fin.merkleRoot, leaf_format: "blindroll:leaf:v1", node: "sha256-sorted-pair" },
      rules: { version: "rules-v1", errors: 0, warnings: 1 },
      edits: { count: 3 },
      notes: [],
      approval_policy: { approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2 },
    });
    expect(report.rules.results).toHaveLength(1);
    expect(report.rules.results[0]).toMatchObject({ rule_id: "R006_outlier_vs_run", overridden: true });
    expect(report.rules.results[0]!.row_hash).toBe(fin.rows.find((r) => r.rowNumber === 7)!.rowHashHex);
    expect(report.ai).toMatchObject({
      model: "z-ai/glm-5.3-flash", chat_id: fixture.chat_id, signature_verified: true,
      signature: { kind: "provider_tee", algo: "ecdsa" },
      attestation: { nonce: fixture.nonce, verified: false },
    });
  });

  it("publishes no address, amount per person, name, email, memo or override reason", async () => {
    const text = reportCanonicalJson(buildReport({ ...base, ai: await evidence() }));
    for (const r of fin.rows) {
      expect(text).not.toContain(r.leaf.address);
      expect(text).not.toContain(r.leafHashHex);
      expect(text).not.toContain(`"${r.leaf.amount}"`);
    }
    for (const secret of ["Asha", "example.org", "Community lead", "duplicate row", "sprint"]) expect(text).not.toContain(secret);
  });

  it("hash is stable, canonical and sensitive to every field", async () => {
    const ai = await evidence();
    const report = buildReport({ ...base, ai });
    const hash = reportSha256(report);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reportSha256(JSON.parse(reportCanonicalJson(report)))).toBe(hash); // survives a JSON round trip
    expect(reportSha256(buildReport({ ...base, ai, threshold: 1 }))).not.toBe(hash);
    expect(reportSha256(buildReport({ ...base, ai: null }))).not.toBe(hash);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("notes a defaulted currency and a manual mapping", () => {
    const noCurrency = { ...mapping, mapping: { ...mapping.mapping, currency: null } };
    // Without a currency column row 8 (EUR) is no longer an error, so only rows 6 and 9 go.
    const e2 = [edits[0]!, edits[2]!];
    const review2 = reviewRun({ csv, mapping: noCurrency, edits: e2, overrides });
    const fin2 = finalizeRun({ runKey: RUN_KEY, review: review2, salts });
    const report = buildReport({ ...base, finalized: fin2, review: review2, edits: e2, ai: null });
    expect(report.notes).toEqual(["currency defaulted to USDC"]);
    expect(report.ai).toBeNull();
  });

  it("rejects a bad policy, a bad timestamp and an unready review", () => {
    expect(() => buildReport({ ...base, ai: null, threshold: 3 })).toThrow();
    expect(() => buildReport({ ...base, ai: null, approvers: ["a.testnet", "a.testnet"] })).toThrow();
    expect(() => buildReport({ ...base, ai: null, createdAt: "today" })).toThrow();
    expect(() => buildReport({ ...base, ai: null, review: reviewRun({ csv, mapping }) })).toThrow();
  });

  it("create_run arguments come straight from the report", () => {
    const report = buildReport({ ...base, ai: null });
    expect(buildCreateRunArgs({ report, claimDeadlineMs: 1794000000000, refundAccount: "blindroll-dev.testnet" })).toEqual({
      run_key: RUN_KEY, approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2,
      merkle_root_hex: fin.merkleRoot, report_hash_hex: reportSha256(report), recipient_count: 6,
      total_amount: "14600500000", claim_deadline_ms: 1794000000000, refund_account: "blindroll-dev.testnet",
    });
  });
});
