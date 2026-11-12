// Judge sandbox (docs/02 Flow D, docs/09 "Judge sandbox"): sign-in, isolation and every limit.
// In-memory database, no network: the AI replays the recorded fixture, RPC and relayer are stubs.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type FetchLike, type PayeeDraft, assertNetworkConfig, buildPayeeCsv, sha256 } from "@blindroll/core";
import { assertStartupEnv } from "@blindroll/core/env";
import { SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, approverOrgIds, homeOrgId, issueNonce, verifySignIn } from "../lib/server/auth";
import { type ClaimDeps, exportRun, getReopenCall, listPayouts, prepareClaim, refundSimulatedPayout, submitClaim } from "../lib/server/claims";
import { SANDBOX, type ServerConfig, sandboxOrgId } from "../lib/server/config";
import { type Db, openDb, orgApprovers, orgs, runs } from "../lib/server/db";
import { base58Encode } from "../lib/server/near-tx";
import { serializeNep413 } from "../lib/server/nep413";
import { type RunDeps, addEdit, addOverride, createRun, finalize, getCreateArgs, getRun, listRuns, setManualMapping, syncRun } from "../lib/server/runs";
import { bumpUsage, usageCount } from "../lib/server/sandbox";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
});

const core = new URL("../../../packages/core/test-vectors/ai/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("mapping-fixture.json", core), "utf8"));
const attestationRaw = readFileSync(new URL("attestation-preflight.json", core), "utf8");
const messyCsv = new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-messy.csv", import.meta.url)));
const sandboxCsv = new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-sandbox.csv", import.meta.url)));
const config: ServerConfig = {
  network: "testnet", rpcUrl: "http://rpc.invalid", contractId: "blindroll.blindroll-dev.testnet", tokenId: "usdc.blindroll-dev.testnet",
  aiBaseUrl: fixture.base_url, aiModel: fixture.model, aiLive: true, appUrl: "http://localhost:3000",
  relayerAccountId: "relayer.blindroll-dev.testnet", oneclickBaseUrl: "https://1click.invalid/v0", simSinkAccountId: null,
  judgeSandbox: true, sandboxAiDailyCap: 40,
};
const DEMO = "tushar1962005.testnet";
const JUDGE_A = "judge-a.testnet";
const JUDGE_B = "judge-b.testnet";
const MANUAL = {
  mapping: { name: "Contributor", chain: null, address: "Wallet Addr", amount: "Amt (USD)", currency: "currency", role: "Role", memo: "Notes", email: "E-mail" },
  amount_format: { thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] },
};
const NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n;

/** Replays the recorded NEAR AI response for any request and counts completion calls. Never calls the network. */
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

const payeeCsv = (rows: PayeeDraft[]) => new TextEncoder().encode(buildPayeeCsv(rows));
/** A CSV with the sample's header and `n` valid rows; `salt` makes the bytes (and so the cache key) unique. */
function csvWithRows(n: number, salt = "", amount = "10"): Uint8Array {
  const lines = ["Contributor,E-mail,Wallet Addr,Amt (USD),currency,Role,Notes"];
  for (let i = 0; i < n; i++) lines.push(`P${i},p${i}@example.org,p${i}-${salt || "x"}.testnet,${amount},USDC,Role,${salt}`);
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

describe("sign-in", () => {
  const sk = ed25519.utils.randomSecretKey();
  const publicKey = `ed25519:${base58Encode(ed25519.getPublicKey(sk))}`;
  const signIn = (db: Db, accountId: string, judgeSandbox: boolean | undefined) => {
    const nonce = issueNonce(db, "sign_in");
    const signature = Buffer.from(ed25519.sign(sha256(serializeNep413({ message: SIGN_IN_MESSAGE, nonce: Buffer.from(nonce, "base64"), recipient: SIGN_IN_RECIPIENT })), sk)).toString("base64");
    return verifySignIn(db, { accountId, publicKey, signature, nonce }, async () => true, judgeSandbox === undefined ? undefined : { judgeSandbox });
  };

  it("keeps refusing a non-approver when JUDGE_SANDBOX is unset", async () => {
    const db = openDb(":memory:");
    await expect(signIn(db, JUDGE_A, undefined)).rejects.toMatchObject({ status: 403, code: "not_approver" });
    await expect(signIn(db, JUDGE_A, false)).rejects.toMatchObject({ status: 403, code: "not_approver" });
    expect(db.select().from(orgs).all().map((o) => o.id)).toEqual(["demo-org"]);
  });

  it("creates a 1-of-1 sandbox org with JUDGE_SANDBOX=1, and reuses it on the next sign-in", async () => {
    const db = openDb(":memory:");
    expect(await signIn(db, JUDGE_A, true)).toBe(JUDGE_A);
    expect(await signIn(db, JUDGE_A, true)).toBe(JUDGE_A);
    const sandboxOrgs = db.select().from(orgs).all().filter((o) => o.id !== "demo-org");
    expect(sandboxOrgs).toEqual([expect.objectContaining({ id: `sandbox:${JUDGE_A}`, name: `Sandbox – ${JUDGE_A}`, threshold: 1, refundAccount: JUDGE_A })]);
    expect(db.select().from(orgApprovers).all().filter((a) => a.orgId === sandboxOrgId(JUDGE_A))).toEqual([{ orgId: sandboxOrgId(JUDGE_A), accountId: JUDGE_A, position: 0 }]);
    expect(homeOrgId(db, JUDGE_A, true)).toBe(sandboxOrgId(JUDGE_A));
    // Turning the switch off ends sandbox sessions (the next request is refused), rows stay.
    expect(approverOrgIds(db, JUDGE_A, false)).toEqual([]);
  });

  it("leaves demo-org approvers unchanged: no sandbox org, still 2 of 2", async () => {
    const db = openDb(":memory:");
    expect(await signIn(db, DEMO, true)).toBe(DEMO);
    expect(db.select().from(orgs).all().map((o) => o.id)).toEqual(["demo-org"]);
    expect(homeOrgId(db, DEMO, true)).toBe("demo-org");
    expect(db.select().from(orgs).all()[0]!.threshold).toBe(2);
  });

  it("still refuses implicit (64-hex) accounts", async () => {
    const db = openDb(":memory:");
    await expect(signIn(db, "a".repeat(64), true)).rejects.toMatchObject({ code: "implicit_account" });
    expect(db.select().from(orgs).all()).toHaveLength(1);
  });
});

describe("JUDGE_SANDBOX on mainnet", () => {
  it("is a configuration error at start-up and in serverConfig()", async () => {
    expect(() => assertStartupEnv({ NEAR_NETWORK: "mainnet", JUDGE_SANDBOX: "1" })).toThrow("JUDGE_SANDBOX must not be 1 when NEAR_NETWORK is mainnet");
    expect(() => assertStartupEnv({ NEAR_NETWORK: "testnet", JUDGE_SANDBOX: "1" })).not.toThrow();
    expect(() => assertStartupEnv({ NEAR_NETWORK: "mainnet" })).not.toThrow();
    expect(() => assertNetworkConfig({ network: "mainnet", contractId: "blindroll.near", tokenId: "usdc.near", judgeSandbox: true })).toThrow("JUDGE_SANDBOX");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { NEAR_NETWORK: "mainnet", BLINDROLL_CONTRACT_ID: "blindroll.near", USDC_TOKEN_ID: "usdc.near", JUDGE_SANDBOX: "1", SIM_SINK_ACCOUNT_ID: "" });
      vi.resetModules();
      const fresh = await import("../lib/server/config");
      expect(() => fresh.serverConfig()).toThrow("JUDGE_SANDBOX must not be 1 when NEAR_NETWORK is mainnet");
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});

/** Two judges and the demo org, each with one finalized run (manual mapping, no AI). */
async function threeOrgs() {
  const db = openDb(":memory:");
  const deps: RunDeps = { db, config: { ...config, aiLive: false } };
  const { ensureSandboxOrg } = await import("../lib/server/sandbox");
  ensureSandboxOrg(db, JUDGE_A);
  ensureSandboxOrg(db, JUDGE_B);
  const mk = async (accountId: string, orgId: string) => {
    const { runKey } = await createRun(deps, { accountId, orgId, name: `Run of ${accountId}`, source: "payees", csvBytes: payeeCsv([{ name: "Me", wallet: accountId, amount: "10", memo: "" }]) });
    finalize(deps, { accountId, runKey });
    return runKey;
  };
  return { db, deps, runA: await mk(JUDGE_A, sandboxOrgId(JUDGE_A)), runB: await mk(JUDGE_B, sandboxOrgId(JUDGE_B)), runDemo: await mk(DEMO, "demo-org") };
}

function claimDepsFor(db: Db, over: Partial<ClaimDeps> = {}) {
  const relayed: string[] = [];
  const claimed = new Set<string>();
  const deps: ClaimDeps = {
    db, config,
    view: async (_c, method, args) => (method === "is_claimed" ? claimed.has((args as { leaf_hash_hex: string }).leaf_hash_hex) : { status: "Active", claim_deadline_ms: Date.now() + 3_600_000 }),
    accountExists: async () => true,
    isFullAccessKey: async () => true,
    accountBalanceYocto: async () => 2n * NEAR_YOCTO,
    relay: async (call) => {
      relayed.push(call.methodName);
      const leaf = (call.args as { leaf: { address: string; amount: string } }).leaf;
      const row = db.$client.prepare("SELECT leaf_hash FROM run_rows WHERE address = ?").get(leaf.address) as { leaf_hash: string };
      claimed.add(row.leaf_hash);
      return { txHash: "8".repeat(44), failure: null, logs: [] };
    },
    ...over,
  };
  return { deps, relayed };
}

describe("isolation between sandboxes and the demo org", () => {
  it("shows each account only its own runs", async () => {
    const { db, runA, runB, runDemo } = await threeOrgs();
    expect(listRuns(db, JUDGE_A).map((r) => r.runKey)).toEqual([runA]);
    expect(listRuns(db, JUDGE_B).map((r) => r.runKey)).toEqual([runB]);
    expect(listRuns(db, DEMO).map((r) => r.runKey)).toEqual([runDemo]);
  });

  it("refuses judge A on judge B's run and on a demo-org run, for every run endpoint", async () => {
    const { db, deps, runB, runDemo } = await threeOrgs();
    const { deps: cdeps } = claimDepsFor(db);
    const view = async () => null;
    for (const runKey of [runB, runDemo]) {
      const who = { accountId: JUDGE_A, runKey };
      expect(() => getRun(deps, who)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => finalize(deps, who)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => getCreateArgs(deps, who)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => setManualMapping(deps, { ...who, mapping: MANUAL })).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => addEdit(deps, { ...who, edit: { kind: "remove", rowNumber: 2, reason: "x" } })).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => addOverride(deps, { ...who, findingId: "R006_outlier_vs_run:2", reason: "xyz" })).toThrow(expect.objectContaining({ status: 403 }));
      await expect(syncRun(deps, who, view)).rejects.toMatchObject({ status: 403 });
      await expect(exportRun(cdeps, who)).rejects.toMatchObject({ status: 403 });
      expect(() => listPayouts(cdeps, who)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => getReopenCall(cdeps, { ...who, claimId: 1 })).toThrow(expect.objectContaining({ status: 403 }));
      await expect(refundSimulatedPayout({ ...cdeps, simSink: { accountId: "sink.testnet", send: async () => ({ txHash: "", failure: null, logs: [] }) } }, { ...who, claimId: 1 })).rejects.toMatchObject({ status: 403 });
    }
    // An unknown run is a 404, not a hint that it exists elsewhere.
    expect(() => getRun(deps, { accountId: JUDGE_A, runKey: "run-nope" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("refuses uploads into another org, and keeps demo approvers out of sandboxes", async () => {
    const { deps, runA } = await threeOrgs();
    const file = payeeCsv([{ name: "X", wallet: JUDGE_A, amount: "10", memo: "" }]);
    await expect(createRun(deps, { accountId: JUDGE_A, orgId: "demo-org", name: "x", source: "payees", csvBytes: file })).rejects.toMatchObject({ status: 403 });
    await expect(createRun(deps, { accountId: JUDGE_A, orgId: sandboxOrgId(JUDGE_B), name: "x", source: "payees", csvBytes: file })).rejects.toMatchObject({ status: 403 });
    await expect(createRun(deps, { accountId: DEMO, orgId: sandboxOrgId(JUDGE_A), name: "x", source: "payees", csvBytes: file })).rejects.toMatchObject({ status: 403 });
    expect(() => getRun(deps, { accountId: DEMO, runKey: runA })).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("sends 1-of-1 create_run arguments for a sandbox run and keeps 2 of 2 for the demo org", async () => {
    const { deps, runA, runDemo } = await threeOrgs();
    const a = getCreateArgs(deps, { accountId: JUDGE_A, runKey: runA }).args;
    expect(a).toMatchObject({ approvers: [JUDGE_A], threshold: 1, refund_account: JUDGE_A });
    const d = getCreateArgs(deps, { accountId: DEMO, runKey: runDemo }).args;
    expect(d).toMatchObject({ approvers: ["tushar1962005.testnet", "tushar-approver2.testnet"], threshold: 2, refund_account: "tushar1962005.testnet" });
    expect(getRun(deps, { accountId: JUDGE_A, runKey: runA })).toMatchObject({ sandbox: true, org: { threshold: 1, approvers: [JUDGE_A] } });
    expect(getRun(deps, { accountId: DEMO, runKey: runDemo })).toMatchObject({ sandbox: false, org: { threshold: 2 } });
  });

  it("defaults a sandbox run's claim window to 15 minutes (the demo org keeps 14 days)", async () => {
    const before = Date.now();
    const { deps, runA, runDemo } = await threeOrgs();
    const a = getRun(deps, { accountId: JUDGE_A, runKey: runA }).finalized!.claimDeadlineMs;
    expect(a).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(a).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(getRun(deps, { accountId: DEMO, runKey: runDemo }).finalized!.claimDeadlineMs).toBeGreaterThan(before + 13 * 86_400_000);
  });
});

describe("sandbox limits on runs", () => {
  const A = sandboxOrgId(JUDGE_A);
  async function judge() {
    const db = openDb(":memory:");
    const { ensureSandboxOrg } = await import("../lib/server/sandbox");
    ensureSandboxOrg(db, JUDGE_A);
    ensureSandboxOrg(db, JUDGE_B);
    return db;
  }

  it("allows 5 runs per UTC day, then refuses; the demo org has no such limit", async () => {
    const db = await judge();
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    const one = (accountId: string, orgId: string) => createRun(deps, { accountId, orgId, name: "r", source: "payees", csvBytes: payeeCsv([{ name: "", wallet: JUDGE_A, amount: "1", memo: "" }]) });
    for (let i = 0; i < SANDBOX.runsPerDay; i++) await one(JUDGE_A, A);
    await expect(one(JUDGE_A, A)).rejects.toMatchObject({ status: 429, code: "sandbox_run_limit" });
    // Yesterday's runs do not count.
    db.update(runs).set({ createdAt: "2000-01-01T00:00:00.000Z" }).run();
    await expect(one(JUDGE_A, A)).resolves.toBeTruthy();
    for (let i = 0; i < 7; i++) await one(DEMO, "demo-org");
  });

  it("allows at most 10 rows per sandbox run (the demo org allows more)", async () => {
    const db = await judge();
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    await expect(createRun(deps, { accountId: JUDGE_A, orgId: A, name: "big", csvBytes: csvWithRows(11) })).rejects.toMatchObject({ status: 400, code: "sandbox_row_limit" });
    await expect(createRun(deps, { accountId: JUDGE_A, orgId: A, name: "ok", csvBytes: csvWithRows(10) })).resolves.toBeTruthy();
    await expect(createRun(deps, { accountId: DEMO, orgId: "demo-org", name: "big", csvBytes: csvWithRows(11) })).resolves.toBeTruthy();
  });

  it("allows at most 1,000 USDC per sandbox run: Finalize and create-args refuse more", async () => {
    const db = await judge();
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    const big = payeeCsv([{ name: "", wallet: JUDGE_A, amount: "600", memo: "" }, { name: "", wallet: JUDGE_B, amount: "400.000001", memo: "" }]);
    const { runKey } = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "big", source: "payees", csvBytes: big });
    expect(() => finalize(deps, { accountId: JUDGE_A, runKey })).toThrow(expect.objectContaining({ code: "sandbox_total_limit" }));
    // Exactly 1,000 is allowed.
    const exact = payeeCsv([{ name: "", wallet: JUDGE_A, amount: "600", memo: "" }, { name: "", wallet: JUDGE_B, amount: "400", memo: "" }]);
    const ok = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "ok", source: "payees", csvBytes: exact });
    finalize(deps, { accountId: JUDGE_A, runKey: ok.runKey });
    expect(getCreateArgs(deps, { accountId: JUDGE_A, runKey: ok.runKey }).args.total_amount).toBe("1000000000");
    // The demo org is not limited.
    const demo = await createRun(deps, { accountId: DEMO, orgId: "demo-org", name: "big", source: "payees", csvBytes: big });
    expect(() => finalize(deps, { accountId: DEMO, runKey: demo.runKey })).not.toThrow();
  });

  it("the judge sample CSV shows the documented findings and finalizes under the cap", async () => {
    const db = await judge();
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    const { runKey } = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "sample", csvBytes: sandboxCsv });
    setManualMapping(deps, { accountId: JUDGE_A, runKey, mapping: MANUAL });
    expect(getRun(deps, { accountId: JUDGE_A, runKey }).findings.map((f) => f.id)).toEqual(["R004_duplicate_address:6", "R006_outlier_vs_run:7", "R002_unknown_currency:8", "R001_invalid_address:9"]);
    for (const rowNumber of [6, 8, 9]) addEdit(deps, { accountId: JUDGE_A, runKey, edit: { kind: "remove", rowNumber, reason: "bad row" } });
    addOverride(deps, { accountId: JUDGE_A, runKey, findingId: "R006_outlier_vs_run:7", reason: "approved grant" });
    expect(finalize(deps, { accountId: JUDGE_A, runKey })).toMatchObject({ totalAmount: "730500000", recipientCount: 6 });
    // The public copy that the upload screen links to is the same file.
    expect(readFileSync(new URL("../public/samples/payroll-sandbox.csv", import.meta.url))).toEqual(Buffer.from(sandboxCsv));
  });

  it("allows 2 live AI mappings per sandbox account per day, then falls back to the manual form", async () => {
    const db = await judge();
    const replay = replayFetch();
    const deps: RunDeps = { db, config, ai: { apiKey: "test-key", fetch: replay.fetch } };
    const first = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "1", csvBytes: messyCsv });
    expect(first.mapping).toBe("live");
    await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "2", csvBytes: csvWithRows(3, "two") });
    expect(replay.completions()).toBe(2);
    expect(usageCount(db, JUDGE_A, "ai")).toBe(2);
    const third = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "3", csvBytes: csvWithRows(3, "three") });
    expect(third.mapping).toBe("ai_limit");
    expect(replay.completions()).toBe(2);
    expect(getRun(deps, { accountId: JUDGE_A, runKey: third.runKey })).toMatchObject({ status: "needs_mapping", mapping: null, mappingNote: "ai_limit" });
    // The cache by CSV hash still applies over the limit: the sample costs nothing after the first call.
    expect((await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "4", csvBytes: messyCsv })).mapping).toBe("cached");
    // Another judge has their own allowance, and the demo org is not limited.
    expect((await createRun(deps, { accountId: JUDGE_B, orgId: sandboxOrgId(JUDGE_B), name: "b", csvBytes: csvWithRows(3, "b") })).mapping).not.toBe("ai_limit");
    expect((await createRun(deps, { accountId: DEMO, orgId: "demo-org", name: "d", csvBytes: csvWithRows(3, "demo") })).mapping).not.toBe("ai_limit");
    expect(replay.completions()).toBe(4);
  });

  it("stops live AI calls for every sandbox at the global daily cap (SANDBOX_AI_DAILY_CAP)", async () => {
    const db = await judge();
    const replay = replayFetch();
    const deps: RunDeps = { db, config: { ...config, sandboxAiDailyCap: 3 }, ai: { apiKey: "test-key", fetch: replay.fetch } };
    bumpUsage(db, "someone-else.testnet", "ai");
    bumpUsage(db, "another.testnet", "ai");
    expect((await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "1", csvBytes: csvWithRows(2, "g1") })).mapping).not.toBe("ai_limit");
    expect((await createRun(deps, { accountId: JUDGE_B, orgId: sandboxOrgId(JUDGE_B), name: "2", csvBytes: csvWithRows(2, "g2") })).mapping).toBe("ai_limit");
    expect(replay.completions()).toBe(1);
    // Real orgs are not counted against it.
    expect((await createRun(deps, { accountId: DEMO, orgId: "demo-org", name: "d", csvBytes: csvWithRows(2, "g3") })).mapping).not.toBe("ai_limit");
    expect(replay.completions()).toBe(2);
  });

  it("never calls the AI for hand-typed payees, even over the limits", async () => {
    const db = await judge();
    const replay = replayFetch();
    const deps: RunDeps = { db, config: { ...config, sandboxAiDailyCap: 0 }, ai: { apiKey: "test-key", fetch: replay.fetch } };
    const r = await createRun(deps, { accountId: JUDGE_A, orgId: A, name: "p", source: "payees", csvBytes: payeeCsv([{ name: "", wallet: JUDGE_A, amount: "10", memo: "" }]) });
    expect(r.mapping).toBe("fixed");
    expect(replay.completions()).toBe(0);
  });
});

describe("sandbox limits on relayed (gas-free) claims", () => {
  /** A funded sandbox run (or demo run) with `n` NEAR recipients. */
  async function activeRun(owner: string, n: number) {
    const db = openDb(":memory:");
    const { ensureSandboxOrg } = await import("../lib/server/sandbox");
    const orgId = owner === DEMO ? "demo-org" : ensureSandboxOrg(db, owner);
    const deps: RunDeps = { db, config: { ...config, aiLive: false } };
    const payees = Array.from({ length: n }, (_, i) => ({ name: "", wallet: `r${i}.testnet`, amount: "1", memo: "" }));
    const { runKey } = await createRun(deps, { accountId: owner, orgId, name: "claims", source: "payees", csvBytes: payeeCsv(payees) });
    finalize(deps, { accountId: owner, runKey });
    db.update(runs).set({ status: "active" }).run();
    const claim = async (cdeps: ClaimDeps, i: number) => {
      const scope = { runKey, chain: "near", address: `r${i}.testnet` };
      const p = await prepareClaim(cdeps, scope, { optionId: "near-usdc", receiver: scope.address });
      expect(p).toMatchObject({ relayed: true });
      return submitClaim(cdeps, scope, { claimId: p.claimId });
    };
    return { db, claim };
  }

  it("allows 5 per sandbox account per day, counted for the owner whoever the recipient is", async () => {
    const { db, claim } = await activeRun(JUDGE_A, SANDBOX.relayedClaimsPerDay + 1);
    const { deps, relayed } = claimDepsFor(db);
    for (let i = 0; i < SANDBOX.relayedClaimsPerDay; i++) await expect(claim(deps, i)).resolves.toMatchObject({ status: "confirmed" });
    expect(usageCount(db, JUDGE_A, "relay")).toBe(SANDBOX.relayedClaimsPerDay);
    await expect(claim(deps, SANDBOX.relayedClaimsPerDay)).rejects.toMatchObject({ status: 429, code: "sandbox_relay_limit" });
    expect(relayed).toHaveLength(SANDBOX.relayedClaimsPerDay);
  });

  it("refuses before sending anything when the relayer holds less than 1 NEAR", async () => {
    const { db, claim } = await activeRun(JUDGE_A, 1);
    const { deps, relayed } = claimDepsFor(db, { accountBalanceYocto: async () => NEAR_YOCTO - 1n });
    await expect(claim(deps, 0)).rejects.toMatchObject({ status: 503, code: "relayer_low_balance" });
    expect(relayed).toEqual([]);
    expect(usageCount(db, JUDGE_A, "relay")).toBe(0);
    // Nothing was sent or counted, so the recipient can simply try again once the relayer is topped up.
    const { deps: funded } = claimDepsFor(db);
    await expect(claim(funded, 0)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("does not limit the demo org", async () => {
    const { db, claim } = await activeRun(DEMO, SANDBOX.relayedClaimsPerDay + 1);
    const { deps, relayed } = claimDepsFor(db, { accountBalanceYocto: async () => 0n });
    for (let i = 0; i <= SANDBOX.relayedClaimsPerDay; i++) await claim(deps, i);
    expect(relayed).toHaveLength(SANDBOX.relayedClaimsPerDay + 1);
    expect(usageCount(db, DEMO, "relay")).toBe(0);
  });
});
