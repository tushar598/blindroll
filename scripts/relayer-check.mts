// Checks that the relayer can sign and send a transaction: `pnpm relayer:check`.
// Sends ONE real transaction from the relayer account calling the contract's read-only
// `get_config` method (it changes nothing; the relayer pays a fraction of a cent in gas).
// Never prints the private key.
import { loadAndCheckEnv } from "../packages/core/src/env.ts";
import { parseRelayerKey } from "../apps/web/lib/server/near-tx.ts";
import { relay } from "../apps/web/lib/server/relayer.ts";
import { isFullAccessKey } from "../apps/web/lib/server/rpc.ts";

loadAndCheckEnv();
const account = process.env.RELAYER_ACCOUNT_ID!;
const contract = process.env.BLINDROLL_CONTRACT_ID!;
const key = parseRelayerKey(process.env.RELAYER_PRIVATE_KEY!);
console.log(`relayer ${account}, public key ${key.publicKey}`);
console.log(`key is a full-access key of the account: ${await isFullAccessKey(account, key.publicKey)}`);
const out = await relay({ receiverId: contract, methodName: "get_config", args: {}, gasTgas: 10 });
console.log(`transaction ${out.txHash}: ${out.failure === null ? "succeeded" : `FAILED ${out.failure}`}`);
console.log(`https://${process.env.NEAR_NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${out.txHash}`);
process.exit(out.failure === null ? 0 : 1);
