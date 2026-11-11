// Backend services against an in-memory database. No network: the AI call replays the recorded
// fixture and the NEAR RPC is a stub.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it } from "vitest";
import { type FetchLike, reportSha256, sha256, verifyProof } from "@blindroll/core";
import { HttpError, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, issueNonce, verifySignIn } from "../lib/server/auth";
import type { ServerConfig } from "../lib/server/config";
import { decrypt, encrypt } from "../lib/server/crypto";
import { openDb, runRows, runs } from "../lib/server/db";
import { serializeNep413 } from "../lib/server/nep413";
import { type RunDeps, addEdit, addOverride, createRun, finalize, getCreateArgs, getReportJson, getRun, listRuns, setManualMapping, syncRun } from "../lib/server/runs";
import { createSessionToken, readSessionToken } from "../lib/server/session";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
});

const core = new URL("../../../packages/core/test-vectors/ai/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("mapping-fixture.json", core), "utf8"));
const attestationRaw = readFileSync(new URL("attestation-preflight.json", core), "utf8");
const csvBytes = new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-messy.csv", import.meta.url)));
const config: ServerConfig = {
  network: "testnet", rpcUrl: "http://rpc.invalid", contractId: "blindroll.blindroll-dev.testnet", tokenId: "usdc.blindroll-dev.testnet",
  aiBaseUrl: fixture.base_url, aiModel: fixture.model, aiLive: true, appUrl: "http://localhost:3000",
  relayerAccountId: "relayer.blindroll-dev.testnet", oneclickBaseUrl: "https://1click.invalid/v0", simSinkAccountId: null,
};
const APPROVER = "tushar1962005.testnet";

function replayFetch(): { fetch: FetchLike; completions: () => number } {
  let completions = 0;
  const fetch: FetchLike = async (url) => {
    let body: Uint8Array;
    if (url.includes("/attestation/report")) body = new TextEncoder().encode(attestationRaw);
    else if (url.includes("/chat/completions")) {
      completions++;
      body = new Uint8Array(Buffer.from(fixture.response_body_base64, "base64"));
    } else body = new TextEncoder().encode(JSON.stringify(fixture.signature_response));
    return { status: 200, ok: true, text: async () => new TextDecoder().decode(body), arrayBuffer: async () => body.slice().buffer as ArrayBuffer };
  };
  return { fetch, completions: () => completions };
}

describe("crypto and session", () => {
  it("round-trips and rejects tampering", () => {
    const blob = encrypt("salary table");
    expect(decrypt(blob).toString()).toBe("salary table");
    expect(blob).not.toContain("salary");
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => decrypt(raw.toString("base64"))).toThrow();
  });
  it("issues and reads a session; rejects a forged one", async () => {
    const t = await createSessionToken(APPROVER);
    expect(await readSessionToken(t)).toBe(APPROVER);
    expect(await readSessionToken(t.slice(0, -2) + "xx")).toBeNull();
    expect(await readSessionToken(undefined)).toBeNull();
  });
});

describe("NEP-413 sign-in", () => {
  const sk = ed25519.utils.randomSecretKey();
  const publicKey = `ed25519:${base58(ed25519.getPublicKey(sk))}`;
  const sign = (nonce: string, message = SIGN_IN_MESSAGE) =>
    Buffer.from(ed25519.sign(sha256(serializeNep413({ message, nonce: Buffer.from(nonce, "base64"), recipient: SIGN_IN_RECIPIENT })), sk)).toString("base64");
  const yes = async () => true;

  it("accepts a valid signature from an approver, once", async () => {
    const db = openDb(":memory:");
    const nonce = issueNonce(db, "sign_in");
    const input = { accountId: APPROVER, publicKey, signature: sign(nonce), nonce };
    expect(await verifySignIn(db, input, yes)).toBe(APPROVER);
    await expect(verifySignIn(db, input, yes)).rejects.toMatchObject({ code: "bad_nonce" }); // replay
  });
  it("rejects a wrong message, a foreign key, a non-approver, and an expired or unknown nonce", async () => {
    const db = openDb(":memory:");
    let nonce = issueNonce(db, "sign_in");
    await expect(verifySignIn(db, { accountId: APPROVER, publicKey, signature: sign(nonce, "other"), nonce }, yes)).rejects.toMatchObject({ code: "bad_signature" });
    nonce = issueNonce(db, "sign_in");
    await expect(verifySignIn(db, { accountId: APPROVER, publicKey, signature: sign(nonce), nonce }, async () => false)).rejects.toMatchObject({ code: "key_not_owned" });
    nonce = issueNonce(db, "sign_in");
    await expect(verifySignIn(db, { accountId: "stranger.testnet", publicKey, signature: sign(nonce), nonce }, yes)).rejects.toMatchObject({ code: "not_approver" });
    nonce = issueNonce(db, "sign_in", Date.now() - 10 * 60 * 1000);
    await expect(verifySignIn(db, { accountId: APPROVER, publicKey, signature: sign(nonce), nonce }, yes)).rejects.toMatchObject({ code: "bad_nonce" });
    const unknown = Buffer.alloc(32, 1).toString("base64");
    await expect(verifySignIn(db, { accountId: APPROVER, publicKey, signature: sign(unknown), nonce: unknown }, yes)).rejects.toMatchObject({ code: "bad_nonce" });
  });
});

describe("run flow: upload → review → finalize → create args → sync", () => {
  const db = openDb(":memory:");
  const replay = replayFetch();
  const deps: RunDeps = { db, config, ai: { apiKey: "test-key", fetch: replay.fetch } };
  let runKey = "";

  it("uploads, maps with one AI call, and shows the documented findings", async () => {
    const r = await createRun(deps, { accountId: APPROVER, orgId: "demo-org", name: "October payroll", csvBytes });
    expect(r.mapping).toBe("live");
    runKey = r.runKey;
    const run = getRun(deps, { accountId: APPROVER, runKey });
    expect(run.status).toBe("review");
    expect(run.findings.map((f) => f.id)).toEqual(["R004_duplicate_address:6", "R006_outlier_vs_run:7", "R002_unknown_currency:8", "R001_invalid_address:9"]);
    expect(run.ai).toMatchObject({ model: "z-ai/glm-5.3-flash", signatureVerified: true, attestationVerified: false });
    expect(run.org).toMatchObject({ approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2 });
  });

  it("reuses the cached mapping for the same CSV (no second AI call)", async () => {
    const again = await createRun(deps, { accountId: APPROVER, orgId: "demo-org", name: "Same file", csvBytes });
    expect(again.mapping).toBe("cached");
    expect(replay.completions()).toBe(1);
  });

  it("stores the CSV and identities encrypted", () => {
    const row = db.select().from(runs).all()[0]!;
    expect(row.encCsv).not.toContain("Asha");
    expect(Buffer.from(row.encCsv, "base64").toString("latin1")).not.toContain("asha@example.org");
  });

  it("refuses strangers and unknown runs", () => {
    expect(() => getRun(deps, { accountId: "stranger.testnet", runKey })).toThrow(HttpError);
    expect(() => getRun(deps, { accountId: APPROVER, runKey: "nope" })).toThrow(HttpError);
    expect(listRuns(db, "stranger.testnet")).toEqual([]);
    expect(listRuns(db, APPROVER)).toHaveLength(2);
  });

  it("refuses to finalize with errors, then with an open warning", () => {
    expect(() => finalize(deps, { accountId: APPROVER, runKey })).toThrow("error(s)");
    for (const rowNumber of [6, 8, 9]) addEdit(deps, { accountId: APPROVER, runKey, edit: { kind: "remove", rowNumber, reason: "not payable in this run" } });
    expect(() => addEdit(deps, { accountId: APPROVER, runKey, edit: { kind: "remove", rowNumber: 6, reason: "again" } })).toThrow();
    expect(() => finalize(deps, { accountId: APPROVER, runKey })).toThrow("warning(s)");
  });

  it("overrides only warnings, with a reason", () => {
    expect(() => addOverride(deps, { accountId: APPROVER, runKey, findingId: "R006_outlier_vs_run:7", reason: " " })).toThrow();
    expect(() => addOverride(deps, { accountId: APPROVER, runKey, findingId: "R001_invalid_address:9", reason: "trust me" })).toThrow();
    addOverride(deps, { accountId: APPROVER, runKey, findingId: "R006_outlier_vs_run:7", reason: "Quarterly community grant" });
    expect(getRun(deps, { accountId: APPROVER, runKey }).summary).toMatchObject({ errorCount: 0, openWarningCount: 0, canFinalize: true, rowCount: 6 });
  });

  it("finalizes: root, report hash, proofs, and a public report without private data", () => {
    const f = finalize(deps, { accountId: APPROVER, runKey, claimDays: 14 });
    expect(f).toMatchObject({ totalAmount: "14600500000", recipientCount: 6 });
    const report = JSON.parse(getReportJson(db, runKey)!);
    expect(reportSha256(report)).toBe(f.reportHash);
    expect(report.ai).toMatchObject({ signature_verified: true, attestation: { verified: false } });
    expect(report.approval_policy).toEqual({ approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2 });
    const rows = db.select().from(runRows).all();
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(verifyProof(new Uint8Array(Buffer.from(r.leafHash, "hex")), JSON.parse(r.proofJson), f.merkleRoot)).toBe(true);
      expect(getReportJson(db, runKey)).not.toContain(r.address);
      expect(r.encPayload).not.toContain("example.org");
    }
    expect(() => finalize(deps, { accountId: APPROVER, runKey })).toThrow(HttpError); // already finalized
    expect(() => addEdit(deps, { accountId: APPROVER, runKey, edit: { kind: "remove", rowNumber: 1, reason: "late change" } })).toThrow(HttpError);
  });

  it("returns exact create_run arguments and a deposit", () => {
    const c = getCreateArgs(deps, { accountId: APPROVER, runKey });
    expect(c.contractId).toBe("blindroll.blindroll-dev.testnet");
    expect(c.args).toMatchObject({
      run_key: runKey, approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"], threshold: 2,
      recipient_count: 6, total_amount: "14600500000", refund_account: "blindroll-dev.testnet",
    });
    expect(c.args.claim_deadline_ms).toBeGreaterThan(Date.now());
    expect(c.depositYocto).toBe((50_000_000_000_000_000_000_000n + 6n * 2_250_000_000_000_000_000_000n).toString());
  });

  it("syncs on-chain status and refuses a run with another root", async () => {
    const c = getCreateArgs(deps, { accountId: APPROVER, runKey });
    expect(await syncRun(deps, { accountId: APPROVER, runKey }, async () => null)).toMatchObject({ onChain: false });
    const chain = {
      run_key: runKey, creator: APPROVER, approvers: c.args.approvers, threshold: 2, approvals: [APPROVER],
      merkle_root: c.args.merkle_root_hex, report_hash: c.args.report_hash_hex, recipient_count: 6, total_amount: "14600500000",
      funded_amount: "0", claimed_amount: "0", reclaimed_amount: "0", claim_deadline_ms: c.args.claim_deadline_ms,
      refund_account: "blindroll-dev.testnet", status: "Draft",
    };
    expect(await syncRun(deps, { accountId: APPROVER, runKey }, async () => chain)).toMatchObject({ onChain: true, status: "draft" });
    expect(getRun(deps, { accountId: APPROVER, runKey }).status).toBe("draft");
    await expect(syncRun(deps, { accountId: APPROVER, runKey }, async () => ({ ...chain, merkle_root: "00".repeat(32) }))).rejects.toMatchObject({ code: "chain_mismatch" });
  });
});

describe("manual mapping fallback (AI off)", () => {
  it("waits for a mapping, validates it, and the report says ai: null", async () => {
    const db = openDb(":memory:");
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    const { runKey, mapping } = await createRun(deps, { accountId: APPROVER, orgId: "demo-org", name: "Manual", csvBytes });
    expect(mapping).toBe("ai_off");
    expect(getRun(deps, { accountId: APPROVER, runKey }).status).toBe("needs_mapping");
    const m = {
      mapping: { name: "Contributor", chain: null, address: "Wallet Addr", amount: "Amt (USD)", currency: null, role: "Role", memo: "Notes", email: "E-mail" },
      amount_format: { thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] },
    };
    expect(() => setManualMapping(deps, { accountId: APPROVER, runKey, mapping: { ...m, mapping: { ...m.mapping, address: "Nope" } } })).toThrow();
    setManualMapping(deps, { accountId: APPROVER, runKey, mapping: m });
    for (const rowNumber of [6, 9]) addEdit(deps, { accountId: APPROVER, runKey, edit: { kind: "remove", rowNumber, reason: "bad row" } });
    addOverride(deps, { accountId: APPROVER, runKey, findingId: "R006_outlier_vs_run:7", reason: "approved grant" });
    finalize(deps, { accountId: APPROVER, runKey });
    const report = JSON.parse(getReportJson(db, runKey)!);
    expect(report.ai).toBeNull();
    expect(report.notes).toEqual(["currency defaulted to USDC"]);
  });
});

describe("demo org approvers from DEMO_ORG_APPROVERS", () => {
  it("defaults, parses a list and rejects bad input", async () => {
    const { demoOrgApprovers } = await import("../lib/server/config");
    expect(demoOrgApprovers({})).toEqual(["tushar1962005.testnet", "blindroll-dev.testnet"]);
    expect(demoOrgApprovers({ DEMO_ORG_APPROVERS: " a.testnet, b.testnet " })).toEqual(["a.testnet", "b.testnet"]);
    expect(() => demoOrgApprovers({ DEMO_ORG_APPROVERS: "a.testnet" })).toThrow("2 to 10");
    expect(() => demoOrgApprovers({ DEMO_ORG_APPROVERS: "a.testnet,a.testnet" })).toThrow("repeat");
    expect(() => demoOrgApprovers({ DEMO_ORG_APPROVERS: "a.testnet,Bad Account" })).toThrow("invalid");
  });

  it("replaces the seeded approvers when the configuration changes", async () => {
    const { openDb, orgApprovers } = await import("../lib/server/db");
    const file = join(mkdtempSync(join(tmpdir(), "blindroll-")), "t.sqlite");
    const list = (d: ReturnType<typeof openDb>) => d.select().from(orgApprovers).all().map((a) => a.accountId);
    expect(list(openDb(file))).toEqual(["tushar1962005.testnet", "blindroll-dev.testnet"]);
    process.env.DEMO_ORG_APPROVERS = "tushar1962005.testnet,second.testnet";
    try {
      expect(list(openDb(file))).toEqual(["tushar1962005.testnet", "second.testnet"]);
    } finally {
      delete process.env.DEMO_ORG_APPROVERS;
    }
  });
});
