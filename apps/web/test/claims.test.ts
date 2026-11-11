// Claim flow against an in-memory database. The NEAR RPC, the relayer and 1Click are stubs
// (1Click replays recorded responses); signatures are real, made with the public Hardhat test key #0.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { type OneClickFetch, buildViewMessage, sha256 } from "@blindroll/core";
import { type ClaimDeps, claimStatus, getReopenCall, issueViewChallenge, listPayouts, payoutOptions, prepareClaim, publicRunInfo, recordReopen, refundSimulatedPayout, submitClaim, verifyView } from "../lib/server/claims";
import type { ServerConfig } from "../lib/server/config";
import { openDb, runs } from "../lib/server/db";
import { base58Encode, parseRelayerKey, serializeTransaction, signTransaction } from "../lib/server/near-tx";
import { serializeNep413 } from "../lib/server/nep413";
import { type RunDeps, createRun, finalize, setManualMapping } from "../lib/server/runs";
import { readViewToken } from "../lib/server/session";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
});

const evm = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // Hardhat #0 (public test key)
const EVM_ADDR = evm.address.toLowerCase();
const nearSeed = ed25519.utils.randomSecretKey();
const NEAR_PK = `ed25519:${base58Encode(ed25519.getPublicKey(nearSeed))}`;
const NEAR_ACCT = "recipient.testnet";
const APPROVER = "tushar1962005.testnet";
const config: ServerConfig = {
  network: "testnet", rpcUrl: "http://rpc.invalid", contractId: "blindroll.blindroll-dev.testnet", tokenId: "usdc.blindroll-dev.testnet",
  aiBaseUrl: "http://ai.invalid", aiModel: "m", aiLive: false, appUrl: "http://localhost:3000",
  relayerAccountId: "relayer.blindroll-dev.testnet", oneclickBaseUrl: "https://1click.invalid/v0", simSinkAccountId: null,
};
const csv = `wallet,amount,memo,name\n${EVM_ADDR},1000,October,Eve\n${NEAR_ACCT},250.5,Docs,Nia\n`;
const dir = new URL("../../../packages/core/test-vectors/oneclick/", import.meta.url);
const tokensText = readFileSync(new URL("tokens.json", dir), "utf8");
const quoteText = JSON.stringify(JSON.parse(readFileSync(new URL("quote-dry-base-usdc.json", dir), "utf8")).response);

const SINK = "sim-sink.blindroll-dev.testnet";

async function setup(opts: { sim?: boolean; network?: "testnet" | "mainnet" } = {}) {
  const db = openDb(":memory:");
  const runDeps: RunDeps = { db, config };
  const { runKey } = await createRun(runDeps, { accountId: APPROVER, orgId: "demo-org", name: "Claims", csvBytes: new TextEncoder().encode(csv) });
  setManualMapping(runDeps, {
    accountId: APPROVER, runKey,
    mapping: {
      mapping: { name: "name", chain: null, address: "wallet", amount: "amount", currency: null, role: null, memo: "memo", email: null },
      amount_format: { thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] },
    },
  });
  finalize(runDeps, { accountId: APPROVER, runKey });
  db.update(runs).set({ status: "active" }).run();

  const chain = {
    claimed: new Set<string>(), status: "Active", deadline: Date.now() + 86_400_000, relayed: [] as Array<{ methodName: string; args: Record<string, unknown> }>, failRelay: false,
    sinkSent: [] as Array<{ receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto?: string }>, failSink: false,
  };
  let quoteBodies: string[] = [];
  const oneclickFetch: OneClickFetch = async (url, init) => {
    if (url.endsWith("/tokens")) return { status: 200, ok: true, text: async () => tokensText };
    quoteBodies.push(init?.body ?? "");
    return { status: 201, ok: true, text: async () => quoteText };
  };
  const deps: ClaimDeps = {
    db, config: { ...config, network: opts.network ?? "testnet", simSinkAccountId: opts.sim ? SINK : null },
    ...(opts.sim
      ? {
          simSink: {
            accountId: SINK,
            send: async (call) => {
              chain.sinkSent.push({ receiverId: call.receiverId, methodName: call.methodName, args: call.args as Record<string, unknown>, depositYocto: call.depositYocto });
              return chain.failSink ? { txHash: "6".repeat(44), failure: "not enough balance", logs: [] } : { txHash: "5".repeat(44), failure: null, logs: [] };
            },
          },
        }
      : {}),
    view: async (_c, method, args) => {
      if (method === "is_claimed") return chain.claimed.has((args as { leaf_hash_hex: string }).leaf_hash_hex);
      return { status: chain.status, claim_deadline_ms: chain.deadline };
    },
    accountExists: async (id) => id !== "ghost.testnet",
    isFullAccessKey: async () => true,
    relay: async (call) => {
      chain.relayed.push({ methodName: call.methodName, args: call.args as Record<string, unknown> });
      if (chain.failRelay) return { txHash: "9".repeat(44), failure: "simulated receipt failure", logs: [] };
      // The stub "contract" records the leaf as claimed, like the real one does on success.
      const leaf = (call.args as { leaf: { address: string } }).leaf;
      const row = db.$client.prepare("SELECT leaf_hash FROM run_rows WHERE address = ?").get(leaf.address) as { leaf_hash: string };
      chain.claimed.add(row.leaf_hash);
      return { txHash: "8".repeat(44), failure: null, logs: [] };
    },
    oneclick: { baseUrl: config.oneclickBaseUrl, jwt: "jwt", fetch: oneclickFetch },
  };
  const evmView = async () => {
    const { nonce, issued } = issueViewChallenge(deps, runKey);
    const signature = await evm.signMessage({ message: buildViewMessage({ runKey, address: EVM_ADDR, nonce, issued }) });
    return verifyView(deps, { runKey, chain: "evm", address: evm.address, nonce, issued, signature });
  };
  return { db, deps, runKey, chain, evmView, quoteBodies: () => quoteBodies, resetQuotes: () => (quoteBodies = []) };
}

describe("public run info and the view signature", () => {
  it("shows no amounts or recipients publicly, and hides runs that are not on-chain", async () => {
    const { deps, runKey, db } = await setup();
    const info = publicRunInfo(deps, runKey);
    expect(Object.keys(info).sort()).toEqual(["claimDeadlineMs", "contractId", "network", "orgName", "runKey", "runName", "status", "tokenId"]);
    expect(JSON.stringify(info)).not.toContain(EVM_ADDR);
    db.update(runs).set({ status: "finalized" }).run();
    expect(() => publicRunInfo(deps, runKey)).toThrow("does not exist");
    expect(() => publicRunInfo(deps, "nope")).toThrow("does not exist");
  });

  it("shows an EVM recipient only their own row and issues a scoped token", async () => {
    const { runKey, evmView } = await setup();
    const { row, token } = await evmView();
    expect(row).toMatchObject({ chain: "evm", address: EVM_ADDR, amount: "1000000000", amountDisplay: "1,000.00", name: "Eve", memo: "October", claimed: false, claim: null });
    expect(JSON.stringify(row)).not.toContain(NEAR_ACCT);
    expect(await readViewToken(token, runKey)).toEqual({ runKey, chain: "evm", address: EVM_ADDR });
    expect(await readViewToken(token, "other-run")).toBeNull();
  });

  it("verifies a NEAR recipient with NEP-413", async () => {
    const { deps, runKey } = await setup();
    const { nonce, issued } = issueViewChallenge(deps, runKey);
    const message = buildViewMessage({ runKey, address: NEAR_ACCT, nonce, issued });
    const sig = Buffer.from(ed25519.sign(sha256(serializeNep413({ message, nonce: Buffer.from(nonce, "base64"), recipient: "blindroll" })), nearSeed)).toString("base64");
    const { row } = await verifyView(deps, { runKey, chain: "near", address: NEAR_ACCT, nonce, issued, signature: sig, publicKey: NEAR_PK });
    expect(row).toMatchObject({ chain: "near", amount: "250500000", name: "Nia" });
    const c2 = issueViewChallenge(deps, runKey);
    await expect(verifyView({ ...deps, isFullAccessKey: async () => false }, { runKey, chain: "near", address: NEAR_ACCT, nonce: c2.nonce, issued: c2.issued, signature: sig, publicKey: NEAR_PK })).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects a replayed nonce, someone else's signature, a stale request and unlisted wallets", async () => {
    const { deps, runKey } = await setup();
    const c = issueViewChallenge(deps, runKey);
    const signature = await evm.signMessage({ message: buildViewMessage({ runKey, address: EVM_ADDR, nonce: c.nonce, issued: c.issued }) });
    await verifyView(deps, { runKey, chain: "evm", address: EVM_ADDR, nonce: c.nonce, issued: c.issued, signature });
    await expect(verifyView(deps, { runKey, chain: "evm", address: EVM_ADDR, nonce: c.nonce, issued: c.issued, signature })).rejects.toMatchObject({ code: "bad_nonce" });

    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // Hardhat #1
    const c2 = issueViewChallenge(deps, runKey);
    const forged = await other.signMessage({ message: buildViewMessage({ runKey, address: EVM_ADDR, nonce: c2.nonce, issued: c2.issued }) });
    await expect(verifyView(deps, { runKey, chain: "evm", address: EVM_ADDR, nonce: c2.nonce, issued: c2.issued, signature: forged })).rejects.toMatchObject({ code: "bad_signature" });

    const c3 = issueViewChallenge(deps, runKey);
    const otherAddr = other.address.toLowerCase();
    const sig3 = await other.signMessage({ message: buildViewMessage({ runKey, address: otherAddr, nonce: c3.nonce, issued: c3.issued }) });
    await expect(verifyView(deps, { runKey, chain: "evm", address: otherAddr, nonce: c3.nonce, issued: c3.issued, signature: sig3 })).rejects.toMatchObject({ status: 404, code: "not_listed" });

    const c4 = issueViewChallenge(deps, runKey);
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const sig4 = await evm.signMessage({ message: buildViewMessage({ runKey, address: EVM_ADDR, nonce: c4.nonce, issued: old }) });
    await expect(verifyView(deps, { runKey, chain: "evm", address: EVM_ADDR, nonce: c4.nonce, issued: old, signature: sig4 })).rejects.toMatchObject({ code: "expired" });
  });
});

describe("options board", () => {
  it("offers exact USDC on NEAR plus estimated cross-chain options that cannot be chosen on testnet", async () => {
    const { deps, runKey, quoteBodies } = await setup();
    const scope = { runKey, chain: "evm", address: EVM_ADDR };
    const { options } = await payoutOptions(deps, scope);
    expect(options.map((o) => o.id)).toEqual(["near-usdc", "oneclick:base:USDC", "oneclick:arb:USDC"]);
    expect(options[0]).toMatchObject({ estimatedAmountOut: "1000000000", estimated: false, simulated: false, available: true, feeBps: 0 });
    expect(options[1]).toMatchObject({ rail: "oneclick", estimatedAmountOut: "999805609", estimatedMinAmountOut: "994806580", estimated: true, simulated: false, available: false, etaSeconds: 22 });
    const body = JSON.parse(quoteBodies()[0]!);
    expect(body).toMatchObject({ dry: true, amount: "1000000000", recipient: EVM_ADDR, refundTo: "near" });
    await payoutOptions(deps, scope); // cached for 30 s
    expect(quoteBodies()).toHaveLength(2);
  });
  it("still offers USDC on NEAR when 1Click is down or not configured", async () => {
    const { deps, runKey } = await setup();
    const scope = { runKey, chain: "evm", address: "0x" + "1".repeat(40) };
    await expect(payoutOptions(deps, scope)).rejects.toMatchObject({ code: "not_listed" });
    const down = { ...deps, oneclick: { baseUrl: "x", jwt: "j", fetch: (async () => ({ status: 500, ok: false, text: async () => "" })) as OneClickFetch } };
    const near = { runKey, chain: "near", address: NEAR_ACCT };
    expect((await payoutOptions(down, near)).options.map((o) => o.id)).toEqual(["near-usdc"]);
    expect((await payoutOptions({ ...deps, oneclick: undefined }, near)).options).toHaveLength(1);
  });
});

describe("EVM claim through the relayer", () => {
  it("prepares the exact message, relays claim_evm with the signed target, and confirms from the contract", async () => {
    const { deps, runKey, chain, evmView } = await setup();
    await evmView();
    const scope = { runKey, chain: "evm", address: EVM_ADDR };
    const p = await prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "Payee.Testnet " });
    if (p.kind !== "evm") throw new Error("expected an EVM claim");
    expect(p.message.split("\n")).toEqual([
      "Blindroll claim v1", `contract: ${config.contractId}`, `run: ${runKey}`, expect.stringMatching(/^leaf: [0-9a-f]{64}$/),
      "payout: near_ft:payee.testnet", `to: nep141:${config.tokenId}:payee.testnet`, `expires: ${p.expiresAtMs}`,
    ]);
    const signature = await evm.signMessage({ message: p.message });
    const r = await submitClaim(deps, scope, { claimId: p.claimId, signature });
    expect(r).toEqual({ status: "confirmed", txHash: "8".repeat(44), simulated: false });
    expect(chain.relayed).toHaveLength(1);
    expect(chain.relayed[0]).toMatchObject({
      methodName: "claim_evm",
      args: {
        run_key: runKey, leaf: { chain: "evm", address: EVM_ADDR, amount: "1000000000" }, payout: { kind: "near_ft", receiver: "payee.testnet" },
        destination_asset: `nep141:${config.tokenId}`, destination_address: "payee.testnet", expires_at_ms: p.expiresAtMs, signature_hex: signature.toLowerCase(),
      },
    });
    expect(await claimStatus(deps, scope)).toMatchObject({ claimed: true, claim: { status: "confirmed", payoutTarget: "payee.testnet", simulated: false } });
    await expect(submitClaim(deps, scope, { claimId: p.claimId, signature })).rejects.toMatchObject({ code: "already_submitted" });
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" })).rejects.toMatchObject({ code: "already_claimed" });
  });

  it("refuses a signature from another wallet, a signature over another message, and never relays them", async () => {
    const { deps, runKey, chain } = await setup();
    const scope = { runKey, chain: "evm", address: EVM_ADDR };
    const p = await prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" });
    if (p.kind !== "evm") throw new Error("expected an EVM claim");
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    await expect(submitClaim(deps, scope, { claimId: p.claimId, signature: await other.signMessage({ message: p.message }) })).rejects.toMatchObject({ code: "bad_signature" });
    const redirected = p.message.replace("payee.testnet", "thief.testnet");
    await expect(submitClaim(deps, scope, { claimId: p.claimId, signature: await evm.signMessage({ message: redirected }) })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(submitClaim(deps, scope, { claimId: p.claimId, signature: "0x1234" })).rejects.toMatchObject({ code: "bad_signature" });
    // Another recipient cannot submit this claim id.
    await expect(submitClaim(deps, { runKey, chain: "near", address: NEAR_ACCT }, { claimId: p.claimId })).rejects.toMatchObject({ code: "claim_not_found" });
    expect(chain.relayed).toHaveLength(0);
  });

  it("refuses bad receivers, unknown options, closed runs and passed deadlines", async () => {
    const { deps, runKey, chain } = await setup();
    const scope = { runKey, chain: "evm", address: EVM_ADDR };
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "not an account" })).rejects.toMatchObject({ code: "bad_receiver" });
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "ghost.testnet" })).rejects.toMatchObject({ code: "receiver_not_found" });
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: config.contractId })).rejects.toMatchObject({ code: "bad_receiver" });
    await expect(prepareClaim(deps, scope, { optionId: "oneclick:base:USDC", receiver: "payee.testnet" })).rejects.toMatchObject({ code: "option_unavailable" });
    chain.status = "Closed";
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" })).rejects.toMatchObject({ code: "not_active" });
    chain.status = "Active";
    chain.deadline = Date.now() - 1;
    await expect(prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" })).rejects.toMatchObject({ code: "deadline_passed" });
  });

  it("reports a failed transaction and lets the recipient try again", async () => {
    const { deps, runKey, chain } = await setup();
    const scope = { runKey, chain: "evm", address: EVM_ADDR };
    chain.failRelay = true;
    const p = await prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" });
    if (p.kind !== "evm") throw new Error("expected an EVM claim");
    await expect(submitClaim(deps, scope, { claimId: p.claimId, signature: await evm.signMessage({ message: p.message }) })).rejects.toMatchObject({ code: "claim_failed" });
    expect(await claimStatus(deps, scope)).toMatchObject({ claimed: false, claim: { status: "failed" } });
    chain.failRelay = false;
    const p2 = await prepareClaim(deps, scope, { optionId: "near-usdc", receiver: "payee.testnet" });
    if (p2.kind !== "evm") throw new Error("expected an EVM claim");
    expect((await submitClaim(deps, scope, { claimId: p2.claimId, signature: await evm.signMessage({ message: p2.message }) })).status).toBe("confirmed");
  });
});

describe("NEAR claim (recipient sends claim_near from their own wallet)", () => {
  it("returns the contract call and confirms only once the contract shows the claim", async () => {
    const { deps, runKey, chain, db } = await setup();
    const scope = { runKey, chain: "near", address: NEAR_ACCT };
    const p = await prepareClaim(deps, scope, { optionId: "near-usdc", receiver: NEAR_ACCT });
    if (p.kind !== "near") throw new Error("expected a NEAR claim");
    expect(p.call).toMatchObject({
      contractId: config.contractId, methodName: "claim_near", gasTgas: 100, depositYocto: "0",
      args: { run_key: runKey, leaf: { chain: "near", address: NEAR_ACCT, amount: "250500000" }, payout: { kind: "near_ft", receiver: NEAR_ACCT } },
    });
    expect(await submitClaim(deps, scope, { claimId: p.claimId, txHash: "7".repeat(44) })).toMatchObject({ status: "failed" });
    const row = db.$client.prepare("SELECT leaf_hash FROM run_rows WHERE address = ?").get(NEAR_ACCT) as { leaf_hash: string };
    chain.claimed.add(row.leaf_hash);
    expect(await submitClaim(deps, scope, { claimId: p.claimId, txHash: "7".repeat(44) })).toEqual({ status: "confirmed", txHash: "7".repeat(44), simulated: false });
    expect(chain.relayed).toHaveLength(0);
  });
});

describe("relayer transaction builder", () => {
  const seed = new Uint8Array(32).fill(3);
  const pub = ed25519.getPublicKey(seed);
  const privateKey = `ed25519:${base58Encode(new Uint8Array([...seed, ...pub]))}`;
  const tx = {
    signerId: "relayer.testnet", receiverId: "blindroll.testnet", nonce: 42n, blockHash: base58Encode(new Uint8Array(32).fill(9)),
    methodName: "claim_evm", args: { a: 1 }, gas: 100_000_000_000_000n, deposit: 0n,
  };
  it("parses the NEAR CLI key format and rejects inconsistent keys", () => {
    const key = parseRelayerKey(privateKey);
    expect(key.publicKey).toBe(`ed25519:${base58Encode(pub)}`);
    expect(() => parseRelayerKey("secp256k1:abc")).toThrow();
    expect(() => parseRelayerKey(`ed25519:${base58Encode(new Uint8Array([...seed, ...new Uint8Array(32)]))}`)).toThrow("inconsistent");
  });
  it("serializes a FunctionCall transaction in NEAR's borsh layout", () => {
    const bytes = serializeTransaction(tx, pub);
    const hex = Buffer.from(bytes).toString("hex");
    const s = (x: string) => Buffer.from(x).toString("hex");
    const expected =
      "0f000000" + s("relayer.testnet") + "00" + Buffer.from(pub).toString("hex") + "2a00000000000000" +
      "11000000" + s("blindroll.testnet") + "09".repeat(32) + "01000000" + "02" +
      "09000000" + s("claim_evm") + "07000000" + s('{"a":1}') + "00407a10f35a0000" + "00".repeat(16);
    expect(hex).toBe(expected);
  });
  it("signs sha256(transaction) and appends the signature", () => {
    const key = parseRelayerKey(privateKey);
    const { signedBase64, txHash } = signTransaction(tx, key);
    const signed = new Uint8Array(Buffer.from(signedBase64, "base64"));
    const body = serializeTransaction(tx, pub);
    expect(signed.length).toBe(body.length + 1 + 64);
    expect(signed[body.length]).toBe(0);
    expect(ed25519.verify(signed.slice(body.length + 1), sha256(body), pub)).toBe(true);
    expect(txHash).toBe(base58Encode(sha256(body)));
  });
});

describe("simulated cross-chain claim on testnet (sim sink) with a real refund before reopen", () => {
  const scope = (runKey: string) => ({ runKey, chain: "evm", address: EVM_ADDR });

  async function claimSimulated() {
    const ctx = await setup({ sim: true });
    const s = scope(ctx.runKey);
    const { options } = await payoutOptions(ctx.deps, s);
    const p = await prepareClaim(ctx.deps, s, { optionId: "oneclick:base:USDC" });
    if (p.kind !== "evm") throw new Error("expected an EVM claim");
    const r = await submitClaim(ctx.deps, s, { claimId: p.claimId, signature: await evm.signMessage({ message: p.message }) });
    return { ...ctx, s, options, p, r };
  }

  it("labels the options as simulated and selectable only when the sim sink is configured", async () => {
    const { options } = await claimSimulated();
    expect(options[0]).toMatchObject({ id: "near-usdc", simulated: false, available: true });
    expect(options[1]).toMatchObject({ id: "oneclick:base:USDC", simulated: true, available: true, estimated: true });
    expect(options[1]!.note).toContain("Simulated on testnet");
    const off = await setup();
    expect((await payoutOptions(off.deps, scope(off.runKey))).options[1]).toMatchObject({ simulated: false, available: false });
  });

  it("signs payout oneclick:<sim sink>, relays it, and marks everything simulated", async () => {
    const { deps, s, p, r, chain, runKey } = await claimSimulated();
    expect(p.simulated).toBe(true);
    expect(p.summary).toMatchObject({ label: "USDC on Base", simulated: true, holdingAccount: SINK, receiver: EVM_ADDR, estimatedAmountOut: "999805609" });
    expect(p.message).toContain(`payout: oneclick:${SINK}`);
    expect(p.message).toContain(`to: nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near:${EVM_ADDR}`);
    expect(r).toMatchObject({ status: "confirmed", simulated: true });
    expect(chain.relayed[0]).toMatchObject({ methodName: "claim_evm", args: { payout: { kind: "oneclick", deposit_address: SINK }, destination_address: EVM_ADDR } });
    expect(await claimStatus(deps, s)).toMatchObject({ claimed: true, claim: { simulated: true, payoutStatus: "delivered_simulated", payoutTarget: SINK, refundTx: null } });
    const list = listPayouts(deps, { accountId: APPROVER, runKey });
    expect(list.simSinkAccountId).toBe(SINK);
    expect(list.payouts[0]).toMatchObject({ simulated: true, payoutStatus: "delivered_simulated", payoutKind: "oneclick", amount: "1000000000" });
  });

  it("blocks reopen until the sim sink has really sent the exact amount back to the contract", async () => {
    const { deps, p, chain, runKey, db, s } = await claimSimulated();
    const who = { accountId: APPROVER, runKey, claimId: p.claimId };
    expect(() => getReopenCall(deps, who)).toThrow("after the refund transfer");
    await expect(recordReopen(deps, who)).rejects.toMatchObject({ code: "not_refunded" });

    // A refund transfer that fails changes nothing and keeps reopen blocked.
    chain.failSink = true;
    await expect(refundSimulatedPayout(deps, who)).rejects.toMatchObject({ code: "refund_failed" });
    expect(listPayouts(deps, who).payouts[0]).toMatchObject({ payoutStatus: "delivered_simulated", refundTx: null });
    expect(() => getReopenCall(deps, who)).toThrow();

    chain.failSink = false;
    const refund = await refundSimulatedPayout(deps, who);
    expect(refund).toEqual({ payoutStatus: "refunded_simulated", refundTx: "5".repeat(44), simulated: true });
    expect(chain.sinkSent.at(-1)).toMatchObject({
      receiverId: config.tokenId, methodName: "ft_transfer", depositYocto: "1",
      args: { receiver_id: config.contractId, amount: "1000000000" },
    });
    await expect(refundSimulatedPayout(deps, who)).rejects.toMatchObject({ code: "wrong_status" }); // never twice
    expect(chain.sinkSent).toHaveLength(2);
    expect(await claimStatus(deps, s)).toMatchObject({ claim: { payoutStatus: "refunded_simulated", refundTx: "5".repeat(44) } });

    const call = getReopenCall(deps, who);
    expect(call).toMatchObject({ contractId: config.contractId, methodName: "reopen_claim", args: { run_key: runKey } });
    // The approver has not sent reopen_claim yet: the contract still shows the leaf as claimed.
    await expect(recordReopen(deps, who)).rejects.toMatchObject({ code: "still_claimed" });
    chain.claimed.delete((call.args as { leaf_hash_hex: string }).leaf_hash_hex);
    expect(await recordReopen(deps, { ...who, txHash: "4".repeat(44) })).toMatchObject({ payoutStatus: "reopened", reopenTx: "4".repeat(44) });
    expect((db.$client.prepare("SELECT status FROM run_rows WHERE address = ?").get(EVM_ADDR) as { status: string }).status).toBe("reopened");

    // The recipient can claim again, this time for real USDC on NEAR.
    const again = await prepareClaim(deps, s, { optionId: "near-usdc", receiver: "payee.testnet" });
    if (again.kind !== "evm") throw new Error("expected an EVM claim");
    expect((await submitClaim(deps, s, { claimId: again.claimId, signature: await evm.signMessage({ message: again.message }) })).simulated).toBe(false);
  });

  it("only approvers can refund, and only simulated cross-chain payouts", async () => {
    const { deps, p, runKey, chain } = await claimSimulated();
    await expect(refundSimulatedPayout(deps, { accountId: "stranger.testnet", runKey, claimId: p.claimId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(refundSimulatedPayout(deps, { accountId: APPROVER, runKey, claimId: 9999 })).rejects.toMatchObject({ code: "payout_not_found" });
    expect(chain.sinkSent).toHaveLength(0);
    const real = await setup({ sim: true });
    const rp = await prepareClaim(real.deps, scope(real.runKey), { optionId: "near-usdc", receiver: "payee.testnet" });
    if (rp.kind !== "evm") throw new Error("expected an EVM claim");
    await submitClaim(real.deps, scope(real.runKey), { claimId: rp.claimId, signature: await evm.signMessage({ message: rp.message }) });
    await expect(refundSimulatedPayout(real.deps, { accountId: APPROVER, runKey: real.runKey, claimId: rp.claimId })).rejects.toMatchObject({ code: "payout_not_found" });
  });

  it("never simulates on mainnet, even if a sim sink were injected", async () => {
    const { deps, runKey } = await setup({ sim: true, network: "mainnet" });
    const options = (await payoutOptions(deps, scope(runKey))).options;
    expect(options.filter((o) => o.simulated)).toEqual([]);
    expect(options[1]).toMatchObject({ available: false });
    await expect(prepareClaim(deps, scope(runKey), { optionId: "oneclick:base:USDC" })).rejects.toMatchObject({ code: "option_unavailable" });
    await expect(refundSimulatedPayout(deps, { accountId: APPROVER, runKey, claimId: 1 })).rejects.toMatchObject({ code: "simulation_off" });
  });

  it("the payout cannot be sent to the sim sink through the real rail", async () => {
    const { deps, runKey } = await setup({ sim: true });
    await expect(prepareClaim(deps, scope(runKey), { optionId: "near-usdc", receiver: SINK })).rejects.toMatchObject({ code: "bad_receiver" });
  });
});
