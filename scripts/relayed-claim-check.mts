// Real end-to-end check of the gas-free NEAR claim (`claim_near_relayed`, docs/04) on TESTNET.
//
//   pnpm relayed:check plan  <recipient.testnet> <state-file.json>
//       Builds a two-leaf Merkle tree whose NEAR leaf is <recipient> (1.25 test USDC) and prints the
//       NEAR CLI commands that create, approve and fund a throwaway run. Sends nothing.
//   pnpm relayed:check claim <state-file.json>
//       Sends ONE real transaction from the relayer: claim_near_relayed for that leaf. Then reads the
//       contract and the token and reports whether the recipient was paid and paid no gas.
//
// The recipient never signs anything in `claim`. Never prints the relayer's private key.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { assertNetworkConfig, buildTreeFromLeaves, getProof, isNearAccountId, leafHashHex, leafToJson, type Leaf } from "../packages/core/src/index.ts";
import { loadAndCheckEnv } from "../packages/core/src/env.ts";
import { relay } from "../apps/web/lib/server/relayer.ts";
import { viewFunction } from "../apps/web/lib/server/rpc.ts";

loadAndCheckEnv();
const network = process.env.NEAR_NETWORK!;
const contractId = process.env.BLINDROLL_CONTRACT_ID!;
const tokenId = process.env.USDC_TOKEN_ID!;
assertNetworkConfig({ network, contractId, tokenId });
if (network !== "testnet") throw new Error("relayed:check creates a throwaway run and is testnet-only");

const [mode, a, b] = process.argv.slice(2);

async function nearBalanceYocto(accountId: string): Promise<bigint> {
  const res = await fetch(process.env.NEAR_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "blindroll", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const body = (await res.json()) as { result?: { amount?: string } };
  if (!body.result?.amount) throw new Error(`cannot read the NEAR balance of ${accountId}`);
  return BigInt(body.result.amount);
}

if (mode === "plan" && a && b) {
  if (!isNearAccountId(a) || !a.endsWith(".testnet")) throw new Error("the recipient must be a .testnet account");
  const runKey = `relayed-check-${Date.now()}`;
  const leaves: Leaf[] = [
    { chain: "near", address: a, amount: 1_250_000n, saltHex: randomBytes(16).toString("hex") },
    // A second leaf so the proof is not empty. Nobody controls this address; it stays unclaimed.
    { chain: "evm", address: "0x000000000000000000000000000000000000dead", amount: 1_000_000n, saltHex: randomBytes(16).toString("hex") },
  ];
  const tree = buildTreeFromLeaves(runKey, leaves);
  const total = leaves.reduce((n, l) => n + l.amount, 0n).toString();
  const state = {
    runKey, recipient: a, total, root: tree.rootHex, leaf: leafToJson(leaves[0]!), leafHash: leafHashHex(runKey, leaves[0]!), proof: getProof(tree, 0),
    deadlineMs: Date.now() + 24 * 3600 * 1000,
  };
  writeFileSync(b, JSON.stringify(state, null, 2));
  const net = "network-config testnet sign-with-legacy-keychain send";
  const createArgs = JSON.stringify({
    run_key: runKey, approvers: [a], threshold: 1, merkle_root_hex: state.root, report_hash_hex: "00".repeat(32), recipient_count: 2,
    total_amount: total, claim_deadline_ms: state.deadlineMs, refund_account: a,
  });
  console.log(`state written to ${b}\nRun these as ${a} (creator, sole approver and funder of the throwaway run):\n`);
  console.log(`near contract call-function as-transaction ${contractId} create_run json-args '${createArgs}' prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' sign-as ${a} ${net}`);
  console.log(`near contract call-function as-transaction ${contractId} approve_run json-args '{"run_key":"${runKey}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${a} ${net}`);
  console.log(`near contract call-function as-transaction ${tokenId} mint json-args '{"account_id":"${a}","amount":"${total}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${a} ${net}`);
  console.log(`near contract call-function as-transaction ${tokenId} ft_transfer_call json-args '{"receiver_id":"${contractId}","amount":"${total}","msg":"{\\"fund_run\\":\\"${runKey}\\"}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${a} ${net}`);
} else if (mode === "claim" && a) {
  const s = JSON.parse(readFileSync(a, "utf8")) as { runKey: string; recipient: string; leaf: { amount: string }; leafHash: string; proof: string[] };
  const run = await viewFunction<{ status: string } | null>(contractId, "get_run", { run_key: s.runKey });
  if (run?.status !== "Active") throw new Error(`run ${s.runKey} is ${run?.status ?? "missing"}; create, approve and fund it first`);
  const usdcBefore = BigInt(await viewFunction<string>(tokenId, "ft_balance_of", { account_id: s.recipient }));
  const nearBefore = await nearBalanceYocto(s.recipient);

  const out = await relay({ receiverId: contractId, methodName: "claim_near_relayed", args: { run_key: s.runKey, leaf: s.leaf, proof: s.proof }, gasTgas: 100 });
  console.log(`claim_near_relayed sent by ${process.env.RELAYER_ACCOUNT_ID}: ${out.txHash} ${out.failure === null ? "succeeded" : `FAILED ${out.failure}`}`);
  console.log(`https://testnet.nearblocks.io/txns/${out.txHash}`);

  const claimed = await viewFunction<boolean>(contractId, "is_claimed", { run_key: s.runKey, leaf_hash_hex: s.leafHash });
  const usdcAfter = BigInt(await viewFunction<string>(tokenId, "ft_balance_of", { account_id: s.recipient }));
  const nearAfter = await nearBalanceYocto(s.recipient);
  const checks: Array<[string, boolean]> = [
    ["the transaction and all receipts succeeded", out.failure === null],
    ["the contract shows the leaf as claimed", claimed],
    [`the recipient received exactly ${s.leaf.amount} base units of test USDC`, usdcAfter - usdcBefore === BigInt(s.leaf.amount)],
    ["the recipient's NEAR balance did not change (paid no gas)", nearAfter === nearBefore],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
} else {
  console.error("usage: pnpm relayed:check plan <recipient.testnet> <state-file.json> | claim <state-file.json>");
  process.exit(2);
}
