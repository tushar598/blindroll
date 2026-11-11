// Records ONE real NEAR AI Cloud mapping call as a test fixture (docs/05 "Avoid wasting credits").
//   NEAR_AI_LIVE=1 pnpm ai:record
// Order: preflight attestation (with our nonce) -> one completion -> signature fetch.
// Writes packages/core/test-vectors/ai/*. Never writes or prints the API key.
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadAndCheckEnv } from "../packages/core/src/env.ts";
import { parseCsv } from "../packages/core/src/csv/parse.ts";
import { buildMappingRequestBody } from "../packages/core/src/ai/request.ts";

const EXPECTED_MODEL = "z-ai/glm-5.3-flash";
const SIGNING_ALGO = "ecdsa";

function fail(msg: string): never {
  console.error(`ai:record stopped: ${msg}`);
  process.exit(1);
}
const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

loadAndCheckEnv({ required: ["NEAR_AI_API_KEY", "NEAR_AI_BASE_URL", "NEAR_AI_MODEL"] });
if (process.env.NEAR_AI_LIVE !== "1") fail("live calls need NEAR_AI_LIVE=1 on the command line");
const model = process.env.NEAR_AI_MODEL!;
if (model !== EXPECTED_MODEL) fail(`NEAR_AI_MODEL in the env file is not ${EXPECTED_MODEL}; update it and run again`);
const base = process.env.NEAR_AI_BASE_URL!.replace(/\/$/, "");
const key = process.env.NEAR_AI_API_KEY!;

const root = findRepoRoot();
const outDir = join(root, "packages/core/test-vectors/ai");
mkdirSync(outDir, { recursive: true });
const fixtureFile = join(outDir, "mapping-fixture.json");
const attestationFile = join(outDir, "attestation-preflight.json");
if (existsSync(fixtureFile) && process.env.FORCE !== "1") fail("fixture already exists (set FORCE=1 to spend credits again)");

function save(file: string, text: string) {
  if (text.includes(key)) fail(`refusing to write ${file}: content contains the API key`);
  writeFileSync(file, text);
}

// 1. Preflight attestation (no API key needed), before the completion.
const nonce = randomBytes(32).toString("hex");
const attUrl = `${base}/attestation/report?signing_algo=${SIGNING_ALGO}&nonce=${nonce}&model=${encodeURIComponent(model)}&provider=near`;
const attRes = await fetch(attUrl, { headers: { Accept: "application/json", "x-no-aliasing": "true" } });
const attText = await attRes.text();
console.log(`attestation: HTTP ${attRes.status}, ${attText.length} bytes`);
if (!attRes.ok) fail(`attestation request failed: ${attText.slice(0, 300)}`);
save(attestationFile, attText);
const att = JSON.parse(attText);
const candidates: Array<{ signing_address?: string; signing_algo?: string }> = att.model_attestations ?? [];
console.log(`attestation: top-level keys = ${Object.keys(att).join(", ")}; model_attestations = ${candidates.length}`);
if (candidates.length === 0) fail("no model_attestations[] for this model (a provider_tee signature cannot be matched)");

// 2. One completion. The body string below is sent as-is and hashed as-is.
const csv = parseCsv(new Uint8Array(readFileSync(join(root, "docs/samples/payroll-messy.csv"))));
const requestBody = buildMappingRequestBody(csv, model);
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "x-no-aliasing": "true",
  },
  body: requestBody,
});
const responseBytes = new Uint8Array(await res.arrayBuffer());
const responseText = new TextDecoder().decode(responseBytes);
console.log(`completion: HTTP ${res.status}, ${responseBytes.length} bytes, content-encoding=${res.headers.get("content-encoding") ?? "none"}`);

const fixture: Record<string, unknown> = {
  description: "One real NEAR AI Cloud column-mapping call for docs/samples/payroll-messy.csv. Recorded by scripts/record-ai-fixture.mts. Do not edit by hand.",
  recorded_at: new Date().toISOString(),
  base_url: base,
  model,
  signing_algo: SIGNING_ALGO,
  nonce,
  csv_sha256: csv.csvSha256,
  request_body: requestBody,
  request_sha256: sha256Hex(requestBody),
  completion_status: res.status,
  response_body_base64: Buffer.from(responseBytes).toString("base64"),
  response_sha256: sha256Hex(responseBytes),
};
save(fixtureFile, JSON.stringify(fixture, null, 2) + "\n");
if (!res.ok) fail(`completion failed: ${responseText.slice(0, 300)}`);

const completion = JSON.parse(responseText);
const chatId: string = completion.id;
fixture.chat_id = chatId;
console.log(`completion: id present=${Boolean(chatId)}, response model=${completion.model}, usage=${JSON.stringify(completion.usage ?? null)}`);
console.log(`completion content:\n${completion.choices?.[0]?.message?.content}`);

// 3. Signature fetch; a 404 is retried briefly (capped).
let sigStatus = 0;
let sigText = "";
for (let attempt = 1; attempt <= 4; attempt++) {
  const sigRes = await fetch(`${base}/signature/${encodeURIComponent(chatId)}?signing_algo=${SIGNING_ALGO}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  sigStatus = sigRes.status;
  sigText = await sigRes.text();
  console.log(`signature: attempt ${attempt}, HTTP ${sigStatus}`);
  if (sigStatus !== 404) break;
  await sleep(2000);
}
fixture.signature_status = sigStatus;
try {
  fixture.signature_response = JSON.parse(sigText);
} catch {
  fixture.signature_response_raw = sigText;
}
save(fixtureFile, JSON.stringify(fixture, null, 2) + "\n");
if (sigStatus !== 200) fail(`signature fetch failed: ${sigText.slice(0, 300)}`);

const sig = fixture.signature_response as Record<string, string>;
const expectedText = `${model}:${fixture.request_sha256}:${fixture.response_sha256}`;
console.log(`signature: keys = ${Object.keys(sig).join(", ")}`);
console.log(`signature: kind=${sig.signature_kind}, algo=${sig.signing_algo}, error_code=${sig.error_code ?? "none"}`);
console.log(`signature: text matches <model>:<req sha256>:<resp sha256> = ${sig.text === expectedText}`);
const matches = candidates.filter(
  (c) => c.signing_algo === sig.signing_algo && c.signing_address?.toLowerCase() === sig.signing_address?.toLowerCase(),
);
console.log(`signature: signer matches ${matches.length} of ${candidates.length} preflight model attestations`);
console.log(`saved: ${fixtureFile}\nsaved: ${attestationFile}`);
