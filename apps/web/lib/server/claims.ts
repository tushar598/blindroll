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
import { type Db, auditLog, claims, orgApprovers, orgs, runRows, runs } from "./db";
import { normalizeEd25519PublicKey, verifyNep413Any } from "./nep413";
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
  /**
   * TESTNET ONLY. The account that stands in for a 1Click deposit address, and a sender that signs
   * as it. When present (never on mainnet), cross-chain options can be chosen and are SIMULATED.
   */
  simSink?: { accountId: string; send: RelayFn };
}

/** Shown on every cross-chain option: the numbers come from a real 1Click dry quote (no funds move). */
export const ESTIMATE_NOTE = "Estimated from live mainnet quote";

export const SIMULATED_NOTE =
  "Simulated on testnet: 1Click has no testnet, so nothing is delivered on the destination chain. The contract really pays your test USDC to a holding account.";

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
    /** The create_run transaction that stored the report hash (public on-chain data). */
    createTx: run.createTx,
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
          payoutStatus: c.payoutStatus, refundTx: c.refundTx,
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
  input: { runKey: string; chain: string; address: string; nonce: string; issued: string; signature: string; publicKey?: string; callbackUrl?: string },
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
    const publicKey = input.publicKey ? normalizeEd25519PublicKey(input.publicKey) : null;
    if (!isNearAccountId(address) || !publicKey) throw new HttpError(400, "bad_request", "A NEAR account ID and an ed25519 public key are required");
    const message = buildViewMessage({ runKey: input.runKey, address, nonce: input.nonce, issued: input.issued });
    const ok = verifyNep413Any({
      publicKey, signatureBase64: input.signature, message,
      nonce: new Uint8Array(Buffer.from(input.nonce, "base64")), recipient: VIEW_RECIPIENT,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    });
    if (!ok) throw new HttpError(401, "bad_signature", "The wallet signature is not valid");
    if (!(await deps.isFullAccessKey(address, publicKey))) throw new HttpError(401, "key_not_owned", "That key is not a full-access key of the account");
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
    const key = `${deps.config.network}:${row.amount}:${scope.address}:${deps.simSink ? "sim" : "off"}`;
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
              estimated: true,
              ...(mainnet
                ? { simulated: false, available: false, unavailableReason: "Cross-chain claims are not enabled on mainnet in this version." }
                : deps.simSink
                  ? { simulated: true, available: true, note: `${ESTIMATE_NOTE} — delivery simulated on testnet.` }
                  : {
                      simulated: false, available: false,
                      unavailableReason: `${ESTIMATE_NOTE}. Cross-chain delivery does not exist on testnet (1Click is mainnet-only), so this option cannot be chosen here.`,
                    }),
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
 * EVM: the exact claim message for personal_sign. NEAR: nothing to sign when the USDC goes to the
 * recipient's own account (relayed, gas-free); otherwise the claim_near call for their own wallet.
 *
 * `near-usdc`: real; `receiver` is the NEAR account that gets the USDC.
 * `oneclick:<chain>:<symbol>`: TESTNET SIMULATION for EVM recipients. The signed payout target is
 * the sim sink (where a 1Click deposit address would be on mainnet) and the destination is the
 * recipient's own verified EVM address.
 */
export async function prepareClaim(deps: ClaimDeps, scope: ViewScope, input: { optionId: string; receiver?: string }) {
  const run = loadRun(deps.db, scope.runKey);
  const row = loadRow(deps.db, run, scope);
  const leaf = { chain: row.chain, address: row.address, amount: row.amount, salt_hex: row.saltHex };
  const proof = JSON.parse(row.proofJson) as string[];
  const amountDisplay = formatUsdc(BigInt(row.amount));

  let claim: {
    optionId: string; payoutKind: "near_ft" | "oneclick"; payoutTarget: string; destinationAsset: string; destinationAddress: string;
    simulated: boolean; quoteJson: string | null;
  };
  let summary: Record<string, unknown>;

  if (input.optionId === "near-usdc") {
    const receiver = (input.receiver ?? "").trim().toLowerCase();
    if (!isNearAccountId(receiver)) throw new HttpError(400, "bad_receiver", "Enter a valid NEAR account ID to receive the USDC");
    if (receiver === run.contractId || receiver === deps.config.tokenId || receiver === deps.simSink?.accountId) {
      throw new HttpError(400, "bad_receiver", "That account cannot receive a payout");
    }
    if (!(await deps.accountExists(receiver))) throw new HttpError(400, "receiver_not_found", `The account ${receiver} does not exist on ${run.network}`);
    claim = {
      optionId: "near-usdc", payoutKind: "near_ft", payoutTarget: receiver, destinationAsset: `nep141:${deps.config.tokenId}`,
      destinationAddress: receiver, simulated: false, quoteJson: null,
    };
    summary = { label: "USDC on NEAR", receiver, amount: row.amount, amountDisplay, simulated: false };
  } else {
    // Cross-chain: only as a labelled simulation, only off mainnet, only for EVM recipients.
    const option = (await payoutOptions(deps, scope)).options.find((o) => o.id === input.optionId);
    if (!option || option.rail !== "oneclick" || !option.available || !option.simulated || !deps.simSink || deps.config.network === "mainnet" || row.chain !== "evm") {
      throw new HttpError(400, "option_unavailable", "That payout option cannot be chosen here");
    }
    claim = {
      optionId: option.id, payoutKind: "oneclick", payoutTarget: deps.simSink.accountId, destinationAsset: option.destinationAsset,
      destinationAddress: row.address, simulated: true,
      quoteJson: JSON.stringify({ estimatedAmountOut: option.estimatedAmountOut, estimatedMinAmountOut: option.estimatedMinAmountOut ?? null, symbol: option.symbol, decimals: option.decimals, label: option.label }),
    };
    summary = {
      label: option.label, receiver: row.address, amount: row.amount, amountDisplay, simulated: true, note: SIMULATED_NOTE,
      estimatedAmountOut: option.estimatedAmountOut, estimatedMinAmountOut: option.estimatedMinAmountOut ?? null, symbol: option.symbol, decimals: option.decimals,
      holdingAccount: deps.simSink.accountId,
    };
  }
  await assertClaimable(deps, run, row);

  const base = { runId: run.id, rowId: row.id, ...claim, status: "prepared", createdAt: nowIso(), updatedAt: nowIso() };
  if (row.chain === "evm") {
    // Whole seconds; the contract compares against block time in ms.
    const expiresAtMs = Math.floor((Date.now() + CLAIM_TTL_MS) / 1000) * 1000;
    const message = buildClaimMessage({
      contractId: run.contractId, runKey: run.runKey, leafHashHex: row.leafHash, payoutKind: claim.payoutKind, payoutTarget: claim.payoutTarget,
      destinationAsset: claim.destinationAsset, destinationAddress: claim.destinationAddress, expiresAtMs: BigInt(expiresAtMs),
    });
    const claimId = deps.db.insert(claims).values({ ...base, expiresAtMs, message }).returning({ id: claims.id }).get().id;
    return { kind: "evm" as const, claimId, message, expiresAtMs, summary, simulated: claim.simulated };
  }
  const claimId = deps.db.insert(claims).values(base).returning({ id: claims.id }).get().id;
  if (isRelayedNearClaim(row, claim)) {
    // Gas-free: the relayer submits claim_near_relayed, which can only pay the leaf's own account.
    // Nothing to sign: the recipient already proved control of that account with the view signature.
    return { kind: "near" as const, claimId, summary: { ...summary, gasFree: true }, simulated: false, relayed: true as const, call: null };
  }
  return {
    kind: "near" as const, claimId, summary: { ...summary, gasFree: false }, simulated: claim.simulated, relayed: false as const,
    // Another receiver: the recipient sends this from their own wallet and pays the gas (the contract requires predecessor == recipient).
    call: { contractId: run.contractId, methodName: "claim_near", args: { run_key: run.runKey, leaf, proof, payout: { kind: "near_ft", receiver: claim.payoutTarget } }, gasTgas: 100, depositYocto: "0" },
  };
}

/**
 * A NEAR recipient who takes USDC on NEAR to their OWN account is claimed for by the relayer
 * (`claim_near_relayed`, docs/04): the contract pays only the leaf's account, so no signature is needed.
 */
function isRelayedNearClaim(row: { chain: string; address: string }, claim: { payoutKind: string; payoutTarget: string }): boolean {
  return row.chain === "near" && claim.payoutKind === "near_ft" && claim.payoutTarget === row.address;
}

/** The contract's `payout` argument for a stored claim. */
function payoutArg(claim: { payoutKind: string; payoutTarget: string }) {
  return claim.payoutKind === "oneclick" ? { kind: "oneclick", deposit_address: claim.payoutTarget } : { kind: "near_ft", receiver: claim.payoutTarget };
}

function audit(db: Db, actor: string, action: string, runId: number, data: object) {
  db.insert(auditLog).values({ actor, action, runId, dataJson: JSON.stringify(data), createdAt: nowIso() }).run();
}

/**
 * EVM: checks the signature, then the relayer submits claim_evm and pays the gas. The contract
 * re-checks everything, so the relayer cannot change the payout target.
 * NEAR to the recipient's own account: the relayer submits claim_near_relayed and pays the gas.
 * NEAR to another account: the recipient already sent claim_near; this records the transaction
 * once the contract confirms it.
 */
export async function submitClaim(deps: ClaimDeps, scope: ViewScope, input: { claimId: number; signature?: string; txHash?: string }) {
  const { db } = deps;
  const run = loadRun(db, scope.runKey);
  const row = loadRow(db, run, scope);
  const claim = db.select().from(claims).where(and(eq(claims.id, input.claimId), eq(claims.rowId, row.id))).get();
  if (!claim) throw new HttpError(404, "claim_not_found", "Prepare the claim again");

  if (row.chain === "near" && !isRelayedNearClaim(row, claim)) {
    const claimed = await isClaimedOnChain(deps, run, row);
    const txHash = input.txHash && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.txHash) ? input.txHash : null;
    db.update(claims).set({ status: claimed ? "confirmed" : "failed", claimTx: txHash, error: claimed ? null : "The contract does not show this payout as claimed", updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
    if (claimed) db.update(runRows).set({ status: "claimed" }).where(eq(runRows.id, row.id)).run();
    audit(db, `near:${row.address}`, claimed ? "claim_confirmed" : "claim_not_confirmed", run.id, { claim_id: claim.id, tx: txHash });
    return { status: claimed ? "confirmed" : "failed", txHash, simulated: false };
  }

  if (claim.status !== "prepared") throw new HttpError(409, "already_submitted", "This claim was already submitted; prepare a new one if it failed");
  const leafArgs = {
    run_key: run.runKey,
    leaf: { chain: row.chain, address: row.address, amount: row.amount, salt_hex: row.saltHex },
    proof: JSON.parse(row.proofJson) as string[],
  };
  let call: { methodName: string; args: object };
  if (row.chain === "near") {
    // Gas-free NEAR claim. The view token proves the caller controls the leaf's account; the
    // contract accepts this method only from the relayer and pays only that account.
    if (Date.now() - Date.parse(claim.createdAt) > CLAIM_TTL_MS) throw new HttpError(409, "expired", "The claim expired before it was confirmed; start again");
    call = { methodName: "claim_near_relayed", args: leafArgs };
  } else {
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
    call = {
      methodName: "claim_evm",
      args: {
        ...leafArgs,
        payout: payoutArg(claim),
        destination_asset: claim.destinationAsset,
        destination_address: claim.destinationAddress,
        expires_at_ms: claim.expiresAtMs,
        signature_hex: signature,
      },
    };
  }
  await assertClaimable(deps, run, row);

  // Take the claim atomically so a double click cannot submit twice.
  const taken = db.update(claims).set({ status: "submitted", updatedAt: nowIso() }).where(and(eq(claims.id, claim.id), eq(claims.status, "prepared"))).returning({ id: claims.id }).get();
  if (!taken) throw new HttpError(409, "already_submitted", "This claim was already submitted");

  let txHash: string | null = null;
  let error: string | null = null;
  try {
    const outcome = await deps.relay({ receiverId: run.contractId, ...call, gasTgas: 100 });
    txHash = outcome.txHash || null;
    error = outcome.failure;
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : "The relayer could not send the transaction";
  }
  // The contract is the source of truth: a failed token transfer rolls the claim back on-chain.
  const claimed = await isClaimedOnChain(deps, run, row).catch(() => false);
  const status = claimed ? "confirmed" : "failed";
  db.update(claims)
    .set({
      status, claimTx: txHash, error: claimed ? null : (error ?? "The contract did not record the claim"), updatedAt: nowIso(),
      // Simulated cross-chain payout: the USDC is now in the holding account; nothing was delivered anywhere else.
      ...(claimed && claim.payoutKind === "oneclick" && claim.simulated ? { payoutStatus: "delivered_simulated" } : {}),
    })
    .where(eq(claims.id, claim.id))
    .run();
  if (claimed) db.update(runRows).set({ status: "claimed" }).where(eq(runRows.id, row.id)).run();
  audit(db, `relayer:${deps.config.relayerAccountId}`, claimed ? "claim_submitted" : "claim_failed", run.id, { claim_id: claim.id, tx: txHash });
  if (!claimed) throw new HttpError(502, "claim_failed", `The claim transaction did not go through${error ? `: ${error}` : ""}`);
  return { status, txHash, simulated: claim.simulated };
}

// ---------------------------------------------------------------------------------------------
// Approver side: payouts of a run, the simulated refund (a REAL token transfer) and reopen.
// ---------------------------------------------------------------------------------------------

function loadRunForApprover(db: Db, runKey: string, accountId: string): RunRecord {
  const run = db.select().from(runs).where(eq(runs.runKey, runKey)).get();
  if (!run) throw new HttpError(404, "run_not_found", "Run not found");
  const ok = db.select().from(orgApprovers).where(and(eq(orgApprovers.orgId, run.orgId), eq(orgApprovers.accountId, accountId))).get();
  if (!ok) throw new HttpError(403, "forbidden", "You are not an approver of this run's organization");
  return run;
}

/** Confirmed claims of a run with their payout state, for the approver's run page. */
export function listPayouts(deps: ClaimDeps, input: { accountId: string; runKey: string }) {
  const run = loadRunForApprover(deps.db, input.runKey, input.accountId);
  const rows = new Map(deps.db.select().from(runRows).where(eq(runRows.runId, run.id)).all().map((r) => [r.id, r]));
  return {
    simSinkAccountId: deps.simSink?.accountId ?? null,
    payouts: deps.db
      .select()
      .from(claims)
      .where(eq(claims.runId, run.id))
      .orderBy(desc(claims.id))
      .all()
      .filter((c) => c.status === "confirmed")
      .map((c) => {
        const row = rows.get(c.rowId)!;
        return {
          claimId: c.id, chain: row.chain, address: row.address, amount: row.amount, amountDisplay: formatUsdc(BigInt(row.amount)),
          leafHash: row.leafHash, optionId: c.optionId, payoutKind: c.payoutKind, payoutTarget: c.payoutTarget,
          destinationAsset: c.destinationAsset, destinationAddress: c.destinationAddress, claimTx: c.claimTx,
          simulated: c.simulated, payoutStatus: c.payoutStatus, refundTx: c.refundTx, reopenTx: c.reopenTx, updatedAt: c.updatedAt,
        };
      }),
  };
}

function loadSimulatedPayout(deps: ClaimDeps, run: RunRecord, claimId: number) {
  const claim = deps.db.select().from(claims).where(and(eq(claims.id, claimId), eq(claims.runId, run.id))).get();
  if (!claim || claim.status !== "confirmed" || claim.payoutKind !== "oneclick" || !claim.simulated) {
    throw new HttpError(404, "payout_not_found", "That is not a simulated cross-chain payout of this run");
  }
  const row = deps.db.select().from(runRows).where(eq(runRows.id, claim.rowId)).get()!;
  return { claim, row };
}

/**
 * "Refunded (simulated)": the 1Click failure is simulated, the refund is REAL. The sim sink signs an
 * ft_transfer of exactly the claimed amount back to the Blindroll contract. Only after that
 * transaction succeeded is the payout marked refunded, which is what allows reopen_claim: the
 * contract then really holds the USDC again, so a second claim is not paid from other runs' funds.
 */
export async function refundSimulatedPayout(deps: ClaimDeps, input: { accountId: string; runKey: string; claimId: number }) {
  const { db } = deps;
  if (deps.config.network === "mainnet" || !deps.simSink) throw new HttpError(409, "simulation_off", "Simulated payouts are not enabled in this deployment");
  const run = loadRunForApprover(db, input.runKey, input.accountId);
  const { claim, row } = loadSimulatedPayout(deps, run, input.claimId);
  if (claim.payoutTarget !== deps.simSink.accountId) throw new HttpError(409, "wrong_sink", "This payout went to another holding account");
  // Take it atomically: a payout can be refunded at most once.
  const taken = db.update(claims).set({ payoutStatus: "refunding", updatedAt: nowIso() })
    .where(and(eq(claims.id, claim.id), eq(claims.payoutStatus, "delivered_simulated"))).returning({ id: claims.id }).get();
  if (!taken) throw new HttpError(409, "wrong_status", `This payout is "${claim.payoutStatus}", so it cannot be refunded`);

  let txHash: string | null = null;
  let failure: string | null = null;
  try {
    const out = await deps.simSink.send({
      receiverId: deps.config.tokenId,
      methodName: "ft_transfer",
      args: { receiver_id: run.contractId, amount: row.amount, memo: `blindroll simulated refund ${run.runKey}` },
      gasTgas: 30,
      depositYocto: "1",
    });
    txHash = out.txHash || null;
    failure = out.failure;
    if (!txHash && !failure) failure = "the transfer returned no transaction hash";
  } catch (err) {
    failure = err instanceof Error ? err.message.slice(0, 300) : "the refund transfer could not be sent";
  }
  if (failure !== null) {
    // Nothing came back: the payout stays "delivered (simulated)" and reopen stays blocked.
    db.update(claims).set({ payoutStatus: "delivered_simulated", updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
    audit(db, input.accountId, "simulated_refund_failed", run.id, { claim_id: claim.id, tx: txHash });
    throw new HttpError(502, "refund_failed", `The refund transfer did not go through: ${failure}`);
  }
  db.update(claims).set({ payoutStatus: "refunded_simulated", refundTx: txHash, updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
  db.update(runRows).set({ status: "refunded" }).where(eq(runRows.id, row.id)).run();
  audit(db, input.accountId, "simulated_refund_sent", run.id, { claim_id: claim.id, tx: txHash, amount: row.amount });
  return { payoutStatus: "refunded_simulated", refundTx: txHash, simulated: true };
}

/** The reopen_claim call for the approver's wallet. Refused until the refund transfer exists. */
export function getReopenCall(deps: ClaimDeps, input: { accountId: string; runKey: string; claimId: number }) {
  const run = loadRunForApprover(deps.db, input.runKey, input.accountId);
  const { claim, row } = loadSimulatedPayout(deps, run, input.claimId);
  if (claim.payoutStatus !== "refunded_simulated" || !claim.refundTx) {
    throw new HttpError(409, "not_refunded", "Reopen is only possible after the refund transfer has gone through");
  }
  return { contractId: run.contractId, methodName: "reopen_claim", args: { run_key: run.runKey, leaf_hash_hex: row.leafHash }, gasTgas: 30, depositYocto: "0" };
}

/** After the approver sent reopen_claim: record it once the contract no longer shows the leaf as claimed. */
export async function recordReopen(deps: ClaimDeps, input: { accountId: string; runKey: string; claimId: number; txHash?: string }) {
  const run = loadRunForApprover(deps.db, input.runKey, input.accountId);
  const { claim, row } = loadSimulatedPayout(deps, run, input.claimId);
  if (claim.payoutStatus !== "refunded_simulated") throw new HttpError(409, "not_refunded", "This payout has not been refunded");
  if (await isClaimedOnChain(deps, run, row)) throw new HttpError(409, "still_claimed", "The contract still shows this payout as claimed; send reopen_claim first");
  const txHash = input.txHash && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.txHash) ? input.txHash : null;
  deps.db.update(claims).set({ payoutStatus: "reopened", reopenTx: txHash, updatedAt: nowIso() }).where(eq(claims.id, claim.id)).run();
  deps.db.update(runRows).set({ status: "reopened" }).where(eq(runRows.id, row.id)).run();
  audit(deps.db, input.accountId, "claim_reopened", run.id, { claim_id: claim.id, tx: txHash });
  return { payoutStatus: "reopened", reopenTx: txHash, simulated: true };
}

export interface ExportRow {
  /** Position of the recipient's leaf in the Merkle tree (leaves are ordered by leaf hash, not by file order). */
  leaf_index: number;
  name: string;
  role: string;
  memo: string;
  chain: string;
  address: string;
  amount: string;
  amount_base_units: string;
  /** claimed | unclaimed | refunded | reopened (docs/02 Flow C). "claimed" is read from the contract. */
  status: "claimed" | "unclaimed" | "refunded" | "reopened";
  payout_rail: string;
  destination: string;
  destination_asset: string;
  claim_tx: string;
  /** 1Click deposit address; on testnet the sim sink (see `simulated`). */
  deposit_address: string;
  final_status: string;
  refund_tx: string;
  reopen_tx: string;
  simulated: boolean;
}

const EXPORT_COLUMNS: Array<keyof ExportRow> = [
  "leaf_index", "name", "role", "memo", "chain", "address", "amount", "amount_base_units", "status", "payout_rail", "destination",
  "destination_asset", "claim_tx", "deposit_address", "final_status", "refund_tx", "reopen_tx", "simulated",
];

/**
 * Reconciled export (docs/02 Flow C): one row per recipient. Whether a row is claimed comes from the
 * contract (`is_claimed`), not from our database; rail, destination and transactions come from the
 * claim records. Approvers only: it holds names, addresses and amounts.
 */
export async function exportRun(deps: ClaimDeps, input: { accountId: string; runKey: string }) {
  const run = loadRunForApprover(deps.db, input.runKey, input.accountId);
  if (!run.merkleRoot) throw new HttpError(409, "not_finalized", "The run has no final table yet; finalize it first");
  const rows = deps.db.select().from(runRows).where(eq(runRows.runId, run.id)).orderBy(runRows.rowIndex).all();
  // The run exists on-chain once it left "finalized"; before that nothing can be claimed.
  const onChain = !["needs_mapping", "review", "finalized"].includes(run.status);
  const out: ExportRow[] = [];
  for (const row of rows) {
    const payload = decryptJson<{ name?: string; memo?: string; role?: string }>(row.encPayload);
    const claimed = onChain ? await isClaimedOnChain(deps, run, row) : false;
    const c = latestClaim(deps.db, row);
    const confirmed = c && c.status === "confirmed" ? c : null;
    const refunded = confirmed?.payoutStatus === "refunded_simulated" || confirmed?.payoutStatus === "refunding";
    const status: ExportRow["status"] = claimed ? (refunded ? "refunded" : "claimed") : confirmed?.payoutStatus === "reopened" ? "reopened" : "unclaimed";
    const oneclick = confirmed?.payoutKind === "oneclick";
    out.push({
      leaf_index: row.rowIndex,
      name: payload.name ?? "", role: payload.role ?? "", memo: payload.memo ?? "",
      chain: row.chain, address: row.address,
      amount: formatUsdc(BigInt(row.amount)), amount_base_units: row.amount,
      status,
      payout_rail: confirmed ? (oneclick ? "oneclick" : "near-usdc") : "",
      destination: confirmed ? (oneclick ? (confirmed.destinationAddress ?? "") : confirmed.payoutTarget) : "",
      destination_asset: confirmed ? (oneclick ? (confirmed.destinationAsset ?? "") : "USDC on NEAR") : "",
      claim_tx: confirmed?.claimTx ?? "",
      deposit_address: oneclick ? confirmed.payoutTarget : "",
      final_status: confirmed ? (confirmed.payoutStatus ?? (claimed ? "delivered" : "")) : claimed ? "claimed outside this app" : "",
      refund_tx: confirmed?.refundTx ?? "",
      reopen_tx: confirmed?.reopenTx ?? "",
      simulated: confirmed?.simulated === true,
    });
  }
  return { runKey: run.runKey, runName: run.name, network: run.network, contractId: run.contractId, exportedAt: nowIso(), rows: out };
}

/** RFC 4180 CSV. Text that a spreadsheet would run as a formula gets a leading apostrophe. */
export function exportToCsv(rows: ExportRow[]): string {
  const cell = (v: string | number | boolean) => {
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [EXPORT_COLUMNS.join(","), ...rows.map((r) => EXPORT_COLUMNS.map((k) => cell(r[k])).join(","))].join("\r\n") + "\r\n";
}
