// Replays the recorded NEAR AI Cloud fixture. These tests never call the live API (docs/05).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  buildMappingRequestBody,
  buildMappingSample,
  checkPreflightAttestation,
  maskEmails,
  parseCsv,
  parseMappingContent,
  requestColumnMapping,
  verifyAiSignature,
} from "../src/index.ts";

const dir = new URL("../test-vectors/ai/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("mapping-fixture.json", dir), "utf8"));
const attestationRaw = readFileSync(new URL("attestation-preflight.json", dir), "utf8");
const attestation = JSON.parse(attestationRaw);
const csv = parseCsv(new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-messy.csv", import.meta.url))));
const requestBytes = new TextEncoder().encode(fixture.request_body);
const responseBytes = new Uint8Array(Buffer.from(fixture.response_body_base64, "base64"));

type Reply = { status: number; body: string | Uint8Array };
function fakeFetch(route: (url: string, n: number) => Reply): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = route(url, calls.filter((c) => c === url).length);
    const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  };
  return { fetch, calls };
}
const recorded = (url: string): Reply =>
  url.includes("/attestation/report")
    ? { status: 200, body: attestationRaw }
    : url.includes("/chat/completions")
      ? { status: 200, body: responseBytes }
      : { status: 200, body: JSON.stringify(fixture.signature_response) };
const cfg = (fetch: FetchLike) => ({
  baseUrl: fixture.base_url, apiKey: "test-key", model: fixture.model, nonce: fixture.nonce, fetch, retryDelayMs: 0,
});

describe("mapping request", () => {
  it("masks emails", () => {
    expect(maskEmails("asha@example.org")).toBe("a***@example.org");
    expect(maskEmails("pay bob.k+x@mail.example.com now")).toBe("pay b***@mail.example.com now");
    expect(maskEmails("0x8ba1f109551bd432803012645ac136ddd64dba72")).toBe("0x8ba1f109551bd432803012645ac136ddd64dba72");
  });
  it("sends the header and at most 5 rows, no raw emails", () => {
    const s = buildMappingSample(csv);
    expect(s.sample_rows).toHaveLength(5);
    expect(JSON.stringify(s)).not.toContain("asha@example.org");
  });
  it("still builds the exact recorded request bytes (prompt/format drift check)", () => {
    expect(buildMappingRequestBody(csv, fixture.model)).toBe(fixture.request_body);
  });
});

describe("signature verification against the recorded fixture", () => {
  const signature = fixture.signature_response;
  it("verifies the real provider_tee signature", async () => {
    const r = await verifyAiSignature({ model: fixture.model, requestBytes, responseBytes, signature });
    expect(r).toEqual({ kindOk: true, textOk: true, signerOk: true, verified: true });
  });
  it("fails when a response byte changes", async () => {
    const tampered = responseBytes.slice();
    tampered[10] = tampered[10]! ^ 1;
    const r = await verifyAiSignature({ model: fixture.model, requestBytes, responseBytes: tampered, signature });
    expect(r.textOk).toBe(false);
    expect(r.verified).toBe(false);
  });
  it("fails for another model ID, a wrong signer, a gateway kind and another algorithm", async () => {
    const base = { model: fixture.model, requestBytes, responseBytes };
    expect((await verifyAiSignature({ ...base, model: "other/model", signature })).verified).toBe(false);
    const wrongSigner = { ...signature, signing_address: "0x0000000000000000000000000000000000000001" };
    expect((await verifyAiSignature({ ...base, signature: wrongSigner })).signerOk).toBe(false);
    expect((await verifyAiSignature({ ...base, signature: { ...signature, signature_kind: "gateway" } })).verified).toBe(false);
    expect((await verifyAiSignature({ ...base, signature: { ...signature, signing_algo: "ed25519" } })).verified).toBe(false);
    expect((await verifyAiSignature({ ...base, signature: { ...signature, signature: "0x1234" } })).verified).toBe(false);
  });
});

describe("preflight attestation checks", () => {
  const signature = fixture.signature_response;
  it("matches the signer to exactly one report that binds our nonce; DCAP is not verified", () => {
    const r = checkPreflightAttestation({ attestation, nonce: fixture.nonce, signature });
    expect(r).toMatchObject({
      signerMatchesOneReport: true, nonceEchoed: true, quoteBindsSignerAndNonce: true, quoteVerified: false, verified: false,
    });
  });
  it("rejects another nonce, a missing report and duplicate reports", () => {
    expect(checkPreflightAttestation({ attestation, nonce: "00".repeat(32), signature }).nonceEchoed).toBe(false);
    expect(checkPreflightAttestation({ attestation: {}, nonce: fixture.nonce, signature }).signerMatchesOneReport).toBe(false);
    const twice = { model_attestations: [...attestation.model_attestations, ...attestation.model_attestations] };
    expect(checkPreflightAttestation({ attestation: twice, nonce: fixture.nonce, signature }).signerMatchesOneReport).toBe(false);
  });
});

describe("requestColumnMapping (replayed)", () => {
  it("returns the expected mapping with verified signature evidence, in the right call order", async () => {
    const f = fakeFetch(recorded);
    const r = await requestColumnMapping(csv, cfg(f.fetch));
    expect(r.attempts).toBe(1);
    expect(r.mapping.mapping).toEqual({
      name: "Contributor", chain: null, address: "Wallet Addr", amount: "Amt (USD)",
      currency: "currency", role: "Role", memo: "Notes", email: "E-mail",
    });
    expect(r.mapping.amount_format).toEqual({ thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] });
    expect(r.evidence.chatId).toBe(fixture.chat_id);
    expect(r.evidence.requestSha256).toBe(fixture.request_sha256);
    expect(r.evidence.responseSha256).toBe(fixture.response_sha256);
    expect(r.evidence.signatureCheck.verified).toBe(true);
    expect(r.evidence.attestationCheck.signerMatchesOneReport).toBe(true);
    expect(f.calls.map((u) => u.replace(fixture.base_url, "").split("?")[0])).toEqual([
      "/attestation/report", "/chat/completions", `/signature/${fixture.chat_id}`,
    ]);
  });
  it("retries a bad reply once, then gives up (2 completions at most)", async () => {
    const f = fakeFetch((url) => (url.includes("/chat/completions") ? { status: 200, body: '{"id":"x","choices":[{"message":{"content":"not json"}}]}' } : recorded(url)));
    await expect(requestColumnMapping(csv, cfg(f.fetch))).rejects.toThrow("not valid JSON");
    expect(f.calls.filter((u) => u.includes("/chat/completions"))).toHaveLength(2);
  });
  it("marks the call unverified when the signature is unavailable", async () => {
    const f404 = fakeFetch((url) => (url.includes("/signature/") ? { status: 404, body: "" } : recorded(url)));
    const r = await requestColumnMapping(csv, cfg(f404.fetch));
    expect(r.evidence.signature).toBeNull();
    expect(r.evidence.signatureCheck.verified).toBe(false);
    expect(f404.calls.filter((u) => u.includes("/signature/"))).toHaveLength(4);
    const fErr = fakeFetch((url) => (url.includes("/signature/") ? { status: 200, body: '{"error_code":"x","message":"y"}' } : recorded(url)));
    expect((await requestColumnMapping(csv, cfg(fErr.fetch))).evidence.signature).toBeNull();
  });
});

describe("parseMappingContent", () => {
  it("accepts a fenced block and rejects columns that are not in the file", () => {
    const ok = '```json\n{"mapping":{"name":null,"chain":null,"address":"Wallet Addr","amount":"Amt (USD)","currency":null,"role":null,"memo":null,"email":null},"amount_format":{"thousands_separator":null,"decimal_separator":".","currency_symbols":[]}}\n```';
    expect(parseMappingContent(ok, csv.headers).mapping.address).toBe("Wallet Addr");
    expect(() => parseMappingContent(ok.replace("Wallet Addr", "Nope"), csv.headers)).toThrow();
  });
});
