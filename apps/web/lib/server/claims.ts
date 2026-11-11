import { and, desc, eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import {
  EVM_ADDRESS_RE,
  type OneClickConfig,
  type PayoutOption,
  ValidationError,
  buildClaimMessage,
  buildQuoteRequest,
  buildViewMessage,
  feeBps,
  fetchQuote,
  fetchTokens,
  findToken,
  formatUsdc,
  isNearAccountId,
} from "@blindroll/core";
import { HttpError, consumeNonce, issueNonce } from "./auth";
import { ONECLICK_DESTINATIONS, ONECLICK_DRY_REFUND_STAND_IN, type ServerConfig } from "./config";
import { decryptJson } from "./crypto";
import { type Db, auditLog, claims, orgs, runRows, runs } from "./db";
import { verifyNep413Signature } from "./nep413";
import type { RelayFn } from "./relayer";
import { type ViewScope, createViewToken } from "./session";

export const VIEW_RECIPIENT = "blindroll";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const VIEW_MAX_AGE_MS = 5 * 60 * 1000;
const QUOTE_CACHE_MS = 30 * 1000;

export interface ClaimDeps {
  db: Db;
  config: ServerConfig;
  /** NEAR RPC view call. */
  view: (contractId: string, method: string, args: object) => Promise<unknown>;
  accountExists: (accountId: string) => Promise<boolean>;
  isFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>;
  relay: RelayFn;
  /** Absent when 1Click is not configured; the board then shows only USDC on NEAR. */
  oneclick?: OneClickConfig;
}

type RunRecord = typeof runs.$inferSelect;
type RowRecord = typeof runRows.$inferSelect;
const nowIso = () => new Date().toISOString();

function loadRun(db: Db, runKey: string): RunRecord {
  const run = db.select().from(runs).where(eq(runs.runKey, runKey)).get();
  // A run that is not on-chain yet is indistinguishable from one that does not exist.
  if (!run || run.merkleRoot === null || ["needs_mapping", "review", "finalized"].includes(run.status)) {
    throw new HttpError(404, "run_not_found", "This payroll run does not exist or is not open yet");
  }
  return run;
}

function loadRow(db: Db, run: RunRecord, scope: ViewScope): RowRecord {
  const row = db.select().from(runRows).where(and(eq(runRows.runId, run.id), eq(runRows.chain, scope.chain), eq(runRows.address, scope.address))).get();
  if (!row) throw new HttpError(404, "not_listed", "This wallet isn't in this payroll run.");
  return row;
}

/** Public: nothing here depends on who asks, and it shows no amounts and no list (docs/02 Flow B.1). */
export function publicRunInfo(deps: ClaimDeps, runKey: string) {
  const run = loadRun(deps.db, runKey);
  const org = deps.db.select().from(orgs).where(eq(orgs.id, run.orgId)).get();
  return {
    runKey: run.runKey,
    runName: run.name,
    orgName: org?.name ?? "",
    status: run.status,
    claimDeadlineMs: run.claimDeadlineMs,
    network: run.network,
    contractId: run.contractId,
    tokenId: deps.config.tokenId,
  };
}

/** Nonce + timestamp for the view message. The nonce is single-use and valid 5 minutes. */
export function issueViewChallenge(deps: ClaimDeps, runKey: string) {
  loadRun(deps.db, runKey);
  return { nonce: issueNonce(deps.db, `view:${runKey}`), issued: nowIso(), recipient: VIEW_RECIPIENT };
}

async function isClaimedOnChain(deps: ClaimDeps, run: RunRecord, row: RowRecord): Promise<boolean> {
  return (await deps.view(run.contractId, "is_claimed", { run_key: run.runKey, leaf_hash_hex: row.leafHash })) === true;
}

function latestClaim(db: Db, row: RowRecord) {
  return db.select().from(claims).where(eq(claims.rowId, row.id)).orderBy(desc(claims.id)).all().find((c) => c.status !== "prepared") ?? null;
}

async function rowView(deps: ClaimDeps, run: RunRecord, row: RowRecord) {
  const payload = decryptJson<{ name: string; memo: string; role: string }>(row.encPayload);
  const claimed = await isClaimedOnChain(deps, run, row);
  if (claimed && row.status !== "claimed") deps.db.update(runRows).set({ status: "claimed" }).where(eq(runRows.id, row.id)).run();
  const c = latestClaim(deps.db, row);
  return {
    chain: row.chain,
    address: row.address,
    amount: row.amount,
    amountDisplay: formatUsdc(BigInt(row.amount)),
    name: payload.name,
    memo: payload.memo,
    role: payload.role,
    claimed,
    claim: c
      ? {
          status: claimed && c.status !== "failed" ? "confirmed" : c.status,
          optionId: c.optionId, payoutKind: c.payoutKind, payoutTarget: c.payoutTarget,
          destinationAsset: c.destinationAsset, destinationAddress: c.destinationAddress,
          txHash: c.claimTx, error: c.error, simulated: c.simulated,
        }
      : null,
  };
}

/**
 * Verifies the "view my payout" signature and returns only that recipient's row (docs/07).
 * A wallet that is not in the run gets `404 not_listed` and learns nothing else.
 */
export async function verifyView(
  deps: ClaimDeps,
  input: { runKey: string; chain: string; address: string; nonce: string; issued: string; signature: string; publicKey?: string },
) {
  const run = loadRun(deps.db, input.runKey);
  const issuedMs = Date.parse(input.issued);
  if (!Number.isFinite(issuedMs) || Math.abs(Date.now() - issuedMs) > VIEW_MAX_AGE_MS) throw new HttpError(401, "expired", "The view request has expired; try again");
  if (!consumeNonce(deps.db, input.nonce, `view:${input.runKey}`)) throw new HttpError(401, "bad_nonce", "The view nonce is unknown, expired or already used");

  let address: string;
  if (input.chain === "evm") {
    address = input.address.toLowerCase();
    if (!EVM_ADDRESS_RE.test(address)) throw new HttpError(400, "bad_request", "address is not an EVM address");
    const message = buildViewMessage({ runKey: input.runKey, address, nonce: input.nonce, issued: input.issued });
    let ok = false;
    try {
      ok = await verifyMessage({ address: address as `0x${string}`, message, signature: input.signature as `0x${string}` });
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(401, "bad_signature", "The wallet signature is not valid");
  } else if (input.chain === "near") {
    address = input.address;
    if (!isNearAccountId(address) || !input.publicKey) throw new HttpError(400, "bad_request", "A NEAR account ID and public key are required");
    const message = buildViewMessage({ runKey: input.runKey, address, nonce: input.nonce, issued: input.issued });
    const ok = verifyNep413Signature({
      publicKey: input.publicKey, signatureBase64: input.signature, message,
      nonce: new Uint8Array(Buffer.from(input.nonce, "base64")), recipient: VIEW_RECIPIENT,
    });
    if (!ok) throw new HttpError(401, "bad_signature", "The wallet signature is not valid");
    if (!(await deps.isFullAccessKey(address, input.publicKey))) throw new HttpError(401, "key_not_owned", "That key is not a full-access key of the account");
  } else {
    throw new HttpError(400, "unsupported_chain", "Only EVM and NEAR wallets are supported");
  }

  const scope: ViewScope = { runKey: input.runKey, chain: input.chain, address };
  const row = loadRow(deps.db, run, scope); // 404 not_listed
  return { row: await rowView(deps, run, row), token: await createViewToken(scope) };
}

export async function claimStatus(deps: ClaimDeps, scope: ViewScope) {
  const run = loadRun(deps.db, scope.runKey);
  return rowView(deps, run, loadRow(deps.db, run, scope));
}

const quoteCache = new Map<string, { at: number; options: PayoutOption[] }>();

/**
 * Payout options. "USDC on NEAR" is exact. Cross-chain options carry ESTIMATES from real 1Click
 * dry quotes (no funds move). On a test network they are priced with mainnet assets and cannot be
 * chosen: 1Click has no testnet, so nothing could be delivered.
 */
export async function payoutOptions(deps: ClaimDeps, scope: ViewScope): Promise<{ options: PayoutOption[]; quotedAt: string }> {
  const run = loadRun(deps.db, scope.runKey);
  const row = loadRow(deps.db, run, scope);
  const amount = BigInt(row.amount);
  const options: PayoutOption[] = [
    {
      id: "near-usdc", rail: "near-usdc", label: "USDC on NEAR", destinationAsset: `nep141:${deps.config.tokenId}`, destinationChain: "near",
      symbol: "USDC", decimals: 6, estimatedAmountOut: amount.toString(), feeBps: 0, etaSeconds: 2, estimated: false, simulated: false, available: true,
    },
  ];
  // Cross-chain estimates need a destination address of the right kind, so they are quoted for EVM recipients.
  if (deps.oneclick && scope.chain === "evm") {
    const key = `${row.amount}`;
    const hit = quoteCache.get(key);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) {
      options.push(...hit.options);
    } else {
      const quoted: PayoutOption[] = [];
      try {
        const tokens = await fetchTokens(deps.oneclick);
        const origin = findToken(tokens, "near", "USDC");
        const mainnet = deps.config.network === "mainnet";
        for (const [chain, symbol, label] of ONECLICK_DESTINATIONS) {
          const dest = findToken(tokens, chain, symbol);
          if (!origin || !dest) continue;
          try {
            const q = await fetchQuote(
              deps.oneclick,
              buildQuoteRequest({
                dry: true, originAsset: origin.assetId, destinationAsset: dest.assetId, amount, recipient: scope.address,
                refundTo: mainnet ? deps.config.contractId : ONECLICK_DRY_REFUND_STAND_IN, deadline: new Date(Date.now() + CLAIM_TTL_MS),
              }),
            );
            quoted.push({
              id: `oneclick:${chain}:${symbol}`, rail: "oneclick", label, destinationAsset: dest.assetId, destinationChain: chain,
              symbol, decimals: dest.decimals, estimatedAmountOut: q.amountOut.toString(), estimatedMinAmountOut: q.minAmountOut.toString(),
              ...(dest.decimals === origin.decimals ? { feeBps: feeBps(q.amountIn, q.amountOut) } : {}),
              ...(q.timeEstimateSeconds !== undefined ? { etaSeconds: q.timeEstimateSeconds } : {}),
              estimated: true, simulated: false,
              // Cross-chain claims are not built yet on any network; on testnet they cannot be real at all.
              available: false,
              unavailableReason: mainnet
                ? "Cross-chain claims are not enabled in this version."
                : "Estimate from mainnet prices. Cross-chain delivery does not exist on testnet (1Click is mainnet-only), so this option cannot be chosen here.",
            });
          } catch (err) {
            if (!(err instanceof ValidationError)) throw err;
          }
        }
        quoteCache.set(key, { at: Date.now(), options: quoted });
      } catch (err) {
        if (!(err instanceof ValidationError)) console.error("1Click options failed:", (err as Error).name);
      }
      options.push(...quoted);
    }
  }
  return { options, quotedAt: nowIso() };
}

interface ChainRunStatus {
  status: string;
  claim_deadline_ms: number;
}

async function assertClaimable(deps: ClaimDeps, run: RunRecord, row: RowRecord) {
  const chain = (await deps.view(run.contractId, "get_run", { run_key: run.runKey })) as ChainRunStatus | null;
  if (!chain) throw new HttpError(409, "not_on_chain", "This run is not on-chain");
  if (Date.now() > chain.claim_deadline_ms) throw new HttpError(409, "deadline_passed", "The claim deadline has passed");
  if (chain.status !== "Active") throw new HttpError(409, "not_active", `Claims are not open (the run is ${chain.status.toLowerCase()})`);
  if (await isClaimedOnChain(deps, run, row)) throw new HttpError(409, "already_claimed", "This payout has already been claimed");
}

/**
 * Fixes the payout target and returns what the recipient must sign.
 * EVM: the exact claim message for personal_sign. NEAR: the claim_near call for their own wallet.
 * Only the USDC-on-NEAR rail can be prepared in this version.
 */
export async function prepareClaim(deps: ClaimDeps, scope: ViewScope, input: { optionId: string; receiver: string }) {
  const run = loadRun(deps.db, scope.runKey);
  const row = loadRow(deps.db, run, scope);
  if (input.optionId !== "near-usdc") throw new HttpError(400, "option_unavailable", "That payout option cannot be chosen here");
  const receiver = input.receiver.trim().toLowerCase();
  if (!isNearAccountId(receiver)) throw new HttpError(400, "bad_receiver", "Enter a valid NEAR account ID to receive the USDC");
  if (receiver === run.contractId || receiver === deps.config.tokenId) throw new HttpError(400, "bad_receiver", "That account cannot receive a payout");
  if (!(await deps.accountExists(receiver))) throw new HttpError(400, "receiver_not_found", `The account ${receiver} does not exist on ${run.network}`);
  await assertClaimable(deps, run, row);

  const destinationAsset = `nep141:${deps.config.tokenId}`;
  const leaf = { chain: row.chain, address: row.address, amount: row.amount, salt_hex: row.saltHex };
  const proof = JSON.parse(row.proofJson) as string[];
  const payout = { kind: "near_ft", receiver };
  const base = {
    runId: run.id, rowId: row.id, optionId: "near-usdc", payoutKind: "near_ft", payoutTarget: receiver,
    destinationAsset, destinationAddress: receiver, status: "prepared", simulated: false, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const summary = { label: "USDC on NEAR", receiver, amount: row.amount, amountDisplay: formatUsdc(BigInt(row.amount)), simulated: false };

  if (row.chain === "evm") {
    // Whole seconds; the contract compares against block time in ms.
    const expiresAtMs = Math.floor((Date.now() + CLAIM_TTL_MS) / 1000) * 1000;
    const message = buildClaimMessage({
      contractId: run.contractId, runKey: run.runKey, leafHashHex: row.leafHash, payoutKind: "near_ft", payoutTarget: receiver,
      destinationAsset, destinationAddress: receiver, expiresAtMs: BigInt(expiresAtMs),
    });
    const claimId = deps.db.insert(claims).values({ ...base, expiresAtMs, message }).returning({ id: claims.id }).get().id;
    return { kind: "evm" as const, claimId, message, expiresAtMs, summary };
  }
  const claimId = deps.db.insert(claims).values(base).returning({ id: claims.id }).get().id;
  return {
    kind: "near" as const, claimId, summary,
    // The recipient sends this from their own wallet (the contract requires predecessor == recipient).
    call: { contractId: run.contractId, methodName: "claim_near", args: { run_key: run.runKey, leaf, proof, payout }, gasTgas: 100, depositYocto: "0" },
  };
}

function audit(db: Db, actor: string, action: string, runId: number, data: object) {
  db.insert(auditLog).values({ actor, action, runId, dataJson: JSON.stringify(data), createdAt: nowIso() }).run();
}

/**
 * EVM: checks the signature, then the relayer submits claim_evm and pays the gas. The contract
 * re-checks everything, so the relayer cannot change the payout target.
 * NEAR: the recipient already sent claim_near; this records the transaction once the contract confirms it.
 */
export async function submitClaim(deps: ClaimDeps, scope: ViewScope, input: { claimId: number; signature?: string; txHash?: string }) {
  const { db } = deps;
  const run = loadRun(db, scope.runKey);
  const row = loadRow(db, run, scope);
  const claim = db.select().from(claims).where(and(eq(claims.id, input.claimId), eq(claims.rowId, row.id))).get();
  if (!claim) throw new HttpError(404, "claim_not_found", "Prepare the claim again");

  if (row.chain === "near") {
    const claimed = await isClaimedOnChain(deps, run, row);
    const txHash = input.txHash && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.txHash) ? input.txHash : null;
    db.update(claims).set({ status: claimed ? "confirmed" : "failed", claimTx: txHash, error: claimed ? null : "The contract does not show this payout as claimed", updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
    if (claimed) db.update(runRows).set({ status: "claimed" }).where(eq(runRows.id, row.id)).run();
    audit(db, `near:${row.address}`, claimed ? "claim_confirmed" : "claim_not_confirmed", run.id, { claim_id: claim.id, tx: txHash });
    return { status: claimed ? "confirmed" : "failed", txHash, simulated: false };
  }

  if (claim.status !== "prepared") throw new HttpError(409, "already_submitted", "This claim was already submitted; prepare a new one if it failed");
  if (claim.message === null || claim.expiresAtMs === null) throw new HttpError(500, "bad_claim", "The prepared claim is incomplete");
  if (Date.now() > claim.expiresAtMs - 30_000) throw new HttpError(409, "expired", "The claim expired before it was signed; start again");
  const signature = (input.signature ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new HttpError(400, "bad_signature", "The signature must be 65 bytes of hex");
  let ok = false;
  try {
    ok = await verifyMessage({ address: row.address as `0x${string}`, message: claim.message, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, "bad_signature", "The claim signature does not match this wallet");
  await assertClaimable(deps, run, row);

  // Take the claim atomically so a double click cannot submit twice.
  const taken = db.update(claims).set({ status: "submitted", updatedAt: nowIso() }).where(and(eq(claims.id, claim.id), eq(claims.status, "prepared"))).returning({ id: claims.id }).get();
  if (!taken) throw new HttpError(409, "already_submitted", "This claim was already submitted");

  let txHash: string | null = null;
  let error: string | null = null;
  try {
    const outcome = await deps.relay({
      receiverId: run.contractId,
      methodName: "claim_evm",
      args: {
        run_key: run.runKey,
        leaf: { chain: row.chain, address: row.address, amount: row.amount, salt_hex: row.saltHex },
        proof: JSON.parse(row.proofJson) as string[],
        payout: { kind: "near_ft", receiver: claim.payoutTarget },
        destination_asset: claim.destinationAsset,
        destination_address: claim.destinationAddress,
        expires_at_ms: claim.expiresAtMs,
        signature_hex: signature,
      },
      gasTgas: 100,
    });
    txHash = outcome.txHash || null;
    error = outcome.failure;
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : "The relayer could not send the transaction";
  }
  // The contract is the source of truth: a failed token transfer rolls the claim back on-chain.
  const claimed = await isClaimedOnChain(deps, run, row).catch(() => false);
  const status = claimed ? "confirmed" : "failed";
  db.update(claims).set({ status, claimTx: txHash, error: claimed ? null : (error ?? "The contract did not record the claim"), updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
  if (claimed) db.update(runRows).set({ status: "claimed" }).where(eq(runRows.id, row.id)).run();
  audit(db, `relayer:${deps.config.relayerAccountId}`, claimed ? "claim_submitted" : "claim_failed", run.id, { claim_id: claim.id, tx: txHash });
  if (!claimed) throw new HttpError(502, "claim_failed", `The claim transaction did not go through${error ? `: ${error}` : ""}`);
  return { status, txHash, simulated: false };
}
