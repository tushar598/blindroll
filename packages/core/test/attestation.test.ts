// Replays the recorded NEAR AI Cloud attestation. No live API calls (docs/05).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, checkAttestationEvidence, sha256, utf8ToBytes } from "../src/index.ts";

const dir = new URL("../test-vectors/ai/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("mapping-fixture.json", dir), "utf8"));
const raw = readFileSync(new URL("attestation-preflight.json", dir), "utf8");
const hashOf = (t: string) => bytesToHex(sha256(utf8ToBytes(t)));

function ai(text: string, over: { nonce?: string; signer?: string; model?: string } = {}) {
  return {
    model: over.model ?? fixture.model,
    signature: { algo: "ecdsa", signing_address: over.signer ?? fixture.signature_response.signing_address },
    attestation: { nonce: over.nonce ?? fixture.nonce, sha256: hashOf(text) },
  };
}
const state = (r: ReturnType<typeof checkAttestationEvidence>) => Object.fromEntries(r.checks.map((c) => [c.id, c.state]));

/** Returns the fixture with its first model report changed by `f` (and a matching document hash). */
function tamper(f: (m: Record<string, unknown>) => void): string {
  const doc = JSON.parse(raw);
  f(doc.model_attestations[0]);
  return JSON.stringify(doc);
}
function flipQuoteByte(m: Record<string, unknown>, byteOffset: number) {
  const q = m.intel_quote as string;
  const i = byteOffset * 2;
  m.intel_quote = q.slice(0, i) + (q.slice(i, i + 2) === "00" ? "01" : "00") + q.slice(i + 2);
}

describe("attestation evidence checks", () => {
  it("passes the five offline checks on the recorded attestation; DCAP and GPU stay not verified", () => {
    const r = checkAttestationEvidence({ ai: ai(raw), attestationText: raw });
    expect(state(r)).toEqual({
      attestation_document: "pass",
      signer_attested: "pass",
      quote_binds_signer_nonce: "pass",
      rtmr3_event_log: "pass",
      mrconfigid_compose_hash: "pass",
      intel_quote_signature: "not_verified",
      nvidia_gpu_evidence: "not_verified",
    });
    expect(r).toMatchObject({ passed: 5, failed: 0, notVerified: 2, fullyVerified: false });
    expect(r.checks.find((c) => c.id === "nvidia_gpu_evidence")!.detail).toContain("echoes our nonce");
  });

  it("fails when the served document is not the one the report names", () => {
    const r = checkAttestationEvidence({ ai: { ...ai(raw), attestation: { nonce: fixture.nonce, sha256: "00".repeat(32) } }, attestationText: raw });
    expect(state(r).attestation_document).toBe("fail");
    expect(state(r).signer_attested).toBe("not_verified");
    expect(r.fullyVerified).toBe(false);
  });

  it("fails when the document is missing", () => {
    const r = checkAttestationEvidence({ ai: ai(raw), attestationText: null });
    expect(state(r).attestation_document).toBe("fail");
  });

  it("fails when another key signed the response", () => {
    const r = checkAttestationEvidence({ ai: ai(raw, { signer: "0x" + "11".repeat(20) }), attestationText: raw });
    expect(state(r).signer_attested).toBe("fail");
  });

  it("fails when the attestation is for another model", () => {
    const r = checkAttestationEvidence({ ai: ai(raw, { model: "other/model" }), attestationText: raw });
    expect(state(r).signer_attested).toBe("fail");
  });

  it("fails the binding when the nonce differs", () => {
    const r = checkAttestationEvidence({ ai: ai(raw, { nonce: "ab".repeat(32) }), attestationText: raw });
    expect(state(r).quote_binds_signer_nonce).toBe("fail");
  });

  it("fails the binding when report_data in the quote is changed", () => {
    const t = tamper((m) => flipQuoteByte(m, 48 + 520 + 40));
    const r = checkAttestationEvidence({ ai: ai(t), attestationText: t });
    expect(state(r).quote_binds_signer_nonce).toBe("fail");
    expect(state(r).rtmr3_event_log).toBe("pass");
  });

  it("fails the RTMR3 replay when an event payload is changed", () => {
    const t = tamper((m) => {
      const ev = (m.event_log as { imr: number; event: string; event_payload: string }[]).find((e) => e.imr === 3 && e.event === "app-id")!;
      ev.event_payload = "00" + ev.event_payload.slice(2);
    });
    const r = checkAttestationEvidence({ ai: ai(t), attestationText: t });
    expect(state(r).rtmr3_event_log).toBe("fail");
  });

  it("fails the MRCONFIGID check when compose_hash is changed", () => {
    const t = tamper((m) => {
      (m.info as { compose_hash: string }).compose_hash = "ff".repeat(32);
    });
    const r = checkAttestationEvidence({ ai: ai(t), attestationText: t });
    expect(state(r).mrconfigid_compose_hash).toBe("fail");
  });

  it("fails quote checks when the quote is not TDX v4", () => {
    const t = tamper((m) => flipQuoteByte(m, 0));
    const r = checkAttestationEvidence({ ai: ai(t), attestationText: t });
    expect(state(r).quote_binds_signer_nonce).toBe("fail");
    expect(r.checks.find((c) => c.id === "quote_binds_signer_nonce")!.detail).toContain("not a TDX v4 quote");
  });
});
