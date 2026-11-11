// Records real 1Click responses as test fixtures: the token list and DRY quotes (no funds move).
//   pnpm oneclick:record
// Writes packages/core/test-vectors/oneclick/*. Never writes or prints the JWT.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadAndCheckEnv } from "../packages/core/src/env.ts";

loadAndCheckEnv({ required: ["ONECLICK_BASE_URL", "ONECLICK_JWT"] });
const base = process.env.ONECLICK_BASE_URL!.replace(/\/$/, "");
const jwt = process.env.ONECLICK_JWT!;
const out = join(findRepoRoot(), "packages/core/test-vectors/oneclick");
const save = (name: string, text: string) => {
  if (text.includes(jwt)) throw new Error(`refusing to write ${name}: content contains the JWT`);
  writeFileSync(join(out, name), text);
};

const tokensRes = await fetch(`${base}/tokens`);
const tokens = (await tokensRes.json()) as Array<{ assetId: string; blockchain: string; symbol: string; decimals: number }>;
console.log(`tokens: HTTP ${tokensRes.status}, ${tokens.length} entries`);
save("tokens.json", JSON.stringify(tokens, null, 1) + "\n");
const find = (chain: string, symbol: string) => tokens.find((t) => t.blockchain === chain && t.symbol === symbol)?.assetId;
const origin = find("near", "USDC");
if (!origin) throw new Error("USDC on NEAR is not in the token list");

// Fictional sample address from docs/samples; a dry quote does not send anything to it.
const recipient = "0x8ba1f109551bd432803012645ac136ddd64dba72";
for (const [name, chain, symbol] of [["base-usdc", "base", "USDC"], ["arb-usdc", "arb", "USDC"]] as const) {
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 50,
    originAsset: origin,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: find(chain, symbol),
    amount: "1000000000",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    // refundTo must be an existing MAINNET account, or the API answers HTTP 400 "Internal server error".
    // A dry quote moves nothing, so the registrar account is used as a stand-in.
    refundTo: "near",
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  const res = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`quote ${name}: HTTP ${res.status}, ${text.length} bytes`);
  save(`quote-dry-${name}.json`, JSON.stringify({ request: body, status: res.status, response: JSON.parse(text) }, null, 1) + "\n");
  console.log(text.slice(0, 1500));
}
