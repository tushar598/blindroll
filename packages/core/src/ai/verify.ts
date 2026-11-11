import { recoverMessageAddress } from "viem";
import { bytesToHex, hexToBytes, sha256 } from "../hash.js";

/** Body of GET /v1/signature/<chat_id> (field names confirmed against the recorded fixture). */
export interface AiSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface AttestationCandidate {
  signing_address?: string;
  signing_algo?: string;
  request_nonce?: string;
  intel_quote?: string;
  model_name?: string;
}

/** Body of GET /v1/attestation/report?...&model=&provider=near (only the fields we read). */
export interface PreflightAttestation {
  gateway_attestation?: AttestationCandidate;
  model_attestations?: AttestationCandidate[];
}

export interface SignatureCheck {
  /** signature_kind is provider_tee. */
  kindOk: boolean;
  /** text == <model>:<sha256(request bytes)>:<sha256(response bytes)>. */
  textOk: boolean;
  /** EIP-191 signer recovered from text equals signing_address. */
  signerOk: boolean;
  /** All three. */
  verified: boolean;
  reason?: string;
}

export interface AttestationCheck {
  /** Exactly one preflight model report has the same signer and algorithm. */
  signerMatchesOneReport: boolean;
  /** That report echoes our nonce. */
  nonceEchoed: boolean;
  /** The report_data inside its TDX quote is signer address + our nonce. */
  quoteBindsSignerAndNonce: boolean;
  /**
   * Always false in the MVP: the Intel DCAP quote signature, RTMR3 replay, MRCONFIGID and GPU
   * evidence are NOT verified here (docs/05 "MVP fallback"). The raw report is stored instead.
   */
  quoteVerified: false;
  /** Report field `ai.attestation.verified`: true only with full quote verification. */
  verified: false;
  reason?: string;
}

const sha256Hex = (b: Uint8Array) => bytesToHex(sha256(b));

export function expectedSignedText(model: string, requestBytes: Uint8Array, responseBytes: Uint8Array): string {
  return `${model}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
}

/** docs/05 step 4, items 3 and 4. Only `ecdsa` is supported (it is what we request); anything else fails. */
export async function verifyAiSignature(input: {
  model: string;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  signature: AiSignature;
}): Promise<SignatureCheck> {
  const s = input.signature;
  const kindOk = s.signature_kind === "provider_tee";
  const textOk = s.text === expectedSignedText(input.model, input.requestBytes, input.responseBytes);
  let signerOk = false;
  let reason: string | undefined;
  if (s.signing_algo !== "ecdsa") {
    reason = `unsupported signing_algo: ${s.signing_algo}`;
  } else {
    try {
      const hex = (s.signature.startsWith("0x") ? s.signature : `0x${s.signature}`) as `0x${string}`;
      const recovered = await recoverMessageAddress({ message: s.text, signature: hex });
      signerOk = recovered.toLowerCase() === s.signing_address.toLowerCase();
      if (!signerOk) reason = "recovered signer differs from signing_address";
    } catch {
      reason = "signature is malformed";
    }
  }
  if (!reason && !kindOk) reason = `signature_kind is ${s.signature_kind ?? "missing"}, expected provider_tee`;
  if (!reason && !textOk) reason = "signed text does not match the model ID and the request/response hashes";
  return { kindOk, textOk, signerOk, verified: kindOk && textOk && signerOk, ...(reason ? { reason } : {}) };
}

/** Offset of the 64-byte report_data in a TDX v4 quote: 48-byte header + 520 bytes of TD report body. */
const TDX_REPORT_DATA_OFFSET = 568;

/** report_data = 20-byte signer address, 12 zero bytes, 32-byte nonce (seen in the recorded fixture). */
export function quoteReportData(intelQuoteHex: string): string | null {
  try {
    const q = hexToBytes(intelQuoteHex);
    if (q.length < TDX_REPORT_DATA_OFFSET + 64) return null;
    return bytesToHex(q.slice(TDX_REPORT_DATA_OFFSET, TDX_REPORT_DATA_OFFSET + 64));
  } catch {
    return null;
  }
}

/**
 * docs/05 step 4, items 1 and 5, without the DCAP part: matches the signature to exactly one
 * preflight model report and checks the nonce/signer binding fields. `verified` stays false.
 */
export function checkPreflightAttestation(input: {
  attestation: PreflightAttestation;
  nonce: string;
  signature: Pick<AiSignature, "signing_address" | "signing_algo">;
}): AttestationCheck {
  const signer = input.signature.signing_address.toLowerCase();
  const matches = (input.attestation.model_attestations ?? []).filter(
    (c) => c.signing_algo === input.signature.signing_algo && c.signing_address?.toLowerCase() === signer,
  );
  const report = matches.length === 1 ? matches[0] : undefined;
  const nonce = input.nonce.toLowerCase();
  const nonceEchoed = report?.request_nonce?.toLowerCase() === nonce;
  const expected = `${signer.replace(/^0x/, "")}${"00".repeat(12)}${nonce}`;
  const quoteBindsSignerAndNonce = report?.intel_quote ? quoteReportData(report.intel_quote) === expected : false;
  const reason =
    matches.length !== 1
      ? `${matches.length} preflight model reports match the signer (need exactly 1)`
      : !nonceEchoed
        ? "the model report does not echo our nonce"
        : !quoteBindsSignerAndNonce
          ? "the quote's report_data does not bind the signer and nonce"
          : "Intel DCAP quote verification is not performed in the MVP";
  return { signerMatchesOneReport: matches.length === 1, nonceEchoed, quoteBindsSignerAndNonce, quoteVerified: false, verified: false, reason };
}
