// Checks the testnet-only sim sink: `pnpm simsink:check`. Read-only (sends no transaction).
// Prints whether the key in the root .env.local is a full-access key of the account and whether
// the account is registered on the USDC token. Never prints the private key.
import { loadAndCheckEnv } from "../packages/core/src/env.ts";
import { parseRelayerKey } from "../apps/web/lib/server/near-tx.ts";
import { isFullAccessKey, viewFunction } from "../apps/web/lib/server/rpc.ts";

loadAndCheckEnv();
const account = process.env.SIM_SINK_ACCOUNT_ID;
const secret = process.env.SIM_SINK_PRIVATE_KEY;
if (!account || !secret) {
  console.log("sim sink is not configured (SIM_SINK_ACCOUNT_ID / SIM_SINK_PRIVATE_KEY)");
  process.exit(1);
}
if (process.env.NEAR_NETWORK === "mainnet") {
  console.log("sim sink must not be configured on mainnet");
  process.exit(1);
}
const token = process.env.USDC_TOKEN_ID!;
const key = parseRelayerKey(secret);
const fullAccess = await isFullAccessKey(account, key.publicKey);
console.log(`sim sink ${account}, public key ${key.publicKey}`);
console.log(`key is a full-access key of the account: ${fullAccess}`);
const storage = await viewFunction(token, "storage_balance_of", { account_id: account });
console.log(`registered on ${token}: ${storage !== null}`);
const balance = await viewFunction(token, "ft_balance_of", { account_id: account });
console.log(`token balance (base units): ${String(balance)}`);
// Not being registered yet is fine: the contract registers the payout account during a claim.
process.exit(fullAccess ? 0 : 1);
