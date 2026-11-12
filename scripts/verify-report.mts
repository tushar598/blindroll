// Verifies a published report the way the verify page does, from the command line:
//   pnpm report:verify <run_key> [app URL, default APP_URL]
// Fetches the public report JSON, recomputes its sha256, re-verifies the NEAR AI Cloud signature,
// runs the offline attestation checks on the stored attestation, and compares the hash and Merkle
// root with the contract (read-only; no transaction is sent).
import { loadAndCheckEnv } from "../packages/core/src/env.ts";
import { checkAttestationEvidence } from "../packages/core/src/ai/attestation.ts";
import { verifyPublishedReport } from "../packages/core/src/report/verify.ts";
import { viewFunction } from "../apps/web/lib/server/rpc.ts";

loadAndCheckEnv();
const runKey = process.argv[2];
if (!runKey) {
  console.log("usage: pnpm report:verify <run_key> [app URL]");
  process.exit(2);
}
const app = (process.argv[3] ?? process.env.APP_URL!).replace(/\/$/, "");
const res = await fetch(`${app}/api/runs/${runKey}/report`);
if (!res.ok) {
  console.log(`report not available: HTTP ${res.status}`);
  process.exit(1);
}
const v = await verifyPublishedReport(await res.text());
if (!v.report) {
  console.log(`FAIL report format: ${v.problem}`);
  process.exit(1);
}
const chain = await viewFunction<{ report_hash: string; merkle_root: string } | null>(v.report.contract_id, "get_run", { run_key: runKey });
const checks: Array<[string, boolean | null, string]> = [
  ["report is canonical JSON", v.canonical, v.sha256],
  ["report hash matches the contract", chain !== null && chain.report_hash === v.sha256, chain?.report_hash ?? "run not on the contract"],
  ["merkle root matches the contract", chain !== null && chain.merkle_root === v.report.merkle.root, v.report.merkle.root],
  ["NEAR AI Cloud signature", v.ai?.state === "no_ai" ? null : v.ai?.state === "verified", v.ai?.state === "verified" ? `signer ${v.ai.signer}` : v.ai?.state === "failed" ? v.ai.reason : (v.ai?.state ?? "")],
];
if (v.report.ai) {
  const a = await fetch(`${app}/api/runs/${runKey}/attestation`);
  const ev = checkAttestationEvidence({ ai: v.report.ai, attestationText: a.ok ? await a.text() : null });
  // "not verified" prints as NOTE: it is neither a pass nor a failure of the evidence.
  for (const c of ev.checks) checks.push([c.title, c.state === "not_verified" ? null : c.state === "pass", c.detail]);
}

for (const [name, ok, detail] of checks) console.log(`${ok === null ? "NOTE" : ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
process.exit(checks.some(([, ok]) => ok === false) ? 1 : 0);
