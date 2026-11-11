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
