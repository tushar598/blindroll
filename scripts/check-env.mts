// Startup env check for scripts: `pnpm env:check`.
// Loads the repo-root .env.local and prints only the NAMES of missing/empty variables. Never values.
import { EnvError, REQUIRED_ENV, loadAndCheckEnv } from "../packages/core/src/env.ts";
import { assertNetworkConfig } from "../packages/core/src/config.ts";

try {
  const { file } = loadAndCheckEnv();
  assertNetworkConfig({
    network: process.env.NEAR_NETWORK!,
    contractId: process.env.BLINDROLL_CONTRACT_ID!,
    tokenId: process.env.USDC_TOKEN_ID!,
  });
  console.log(`env ok: all ${REQUIRED_ENV.length} required variables are set (${file})`);
  // The model ID is not a secret, but only a yes/no is printed, like everything else here.
  const chosen = "z-ai/glm-5.3-flash"; // docs/05
  console.log(`NEAR_AI_MODEL is the chosen model (${chosen}): ${process.env.NEAR_AI_MODEL === chosen ? "yes" : "NO"}`);
  console.log(`contract/token/relayer IDs: ${process.env.BLINDROLL_CONTRACT_ID}, ${process.env.USDC_TOKEN_ID}, ${process.env.RELAYER_ACCOUNT_ID}`);
} catch (err) {
  if (err instanceof EnvError) {
    console.error(`env check failed (${err.load.fileFound ? "file found" : "file NOT found"}: ${err.load.file})`);
    for (const name of err.missing) console.error(`  missing or empty: ${name}`);
  } else {
    // ValidationError messages name the variable and the rule, not the value.
    console.error(`env check failed: ${(err as Error).message}`);
  }
  process.exit(1);
}
