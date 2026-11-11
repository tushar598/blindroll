/**
 * Checks anyone can run on a published report (docs/05 "Verify page"). Pure and browser-safe:
 * it needs only the report bytes. Comparing the hash with the contract is done by the caller.
 */
import { recoverMessageAddress } from "viem";
import { bytesToHex, sha256, utf8ToBytes } from "../hash.ts";
import { canonicalJson } from "./finalize.ts";
import { type AttestedReport, REPORT_SCHEMA } from "./report.ts";

export type AiSignatureResult =
  /** The approver mapped the columns by hand: there is no AI call to verify. */
  | { state: "no_ai" }
  /** An AI call was used but NEAR AI Cloud returned no signature for it. */
  | { state: "unsigned" }
  | { state: "verified"; signer: string; signedText: string }
  | { state: "failed"; reason: string; signedText: string };

export interface ReportVerification {
  /** The parsed report, or null when the bytes are not a blindroll.report.v1 JSON object. */
  report: AttestedReport | null;
  /** sha256 of the exact bytes served, lowercase hex. This is what create_run stored. */
  sha256: string;
  /** True when the bytes are already RFC 8785 canonical JSON (so the hash has one possible input). */
  canonical: boolean;
  /** Why `report` is null. */
  problem?: string;
  ai: AiSignatureResult | null;
  /** The MVP stores the TEE attestation but does not verify the Intel quote (docs/05 fallback). */
  attestationVerified: boolean;
}

/** `<model>:<sha256 request>:<sha256 response>`: the text NEAR AI Cloud signs (docs/05 step 4). */
export function signedTextOfReport(ai: NonNullable<AttestedReport["ai"]>): string {
  return `${ai.model}:${ai.request_sha256}:${ai.response_sha256}`;
}

async function checkAiSignature(ai: AttestedReport["ai"]): Promise<AiSignatureResult> {
  if (ai === null) return { state: "no_ai" };
  if (ai.signature === null) return { state: "unsigned" };
  const signedText = signedTextOfReport(ai);
  const s = ai.signature;
  if (s.algo !== "ecdsa") return { state: "failed", reason: `unsupported signing algorithm: ${s.algo}`, signedText };
  if (s.kind !== "provider_tee") return { state: "failed", reason: `signature kind is ${s.kind}, expected provider_tee`, signedText };
  try {
    const hex = (s.signature.startsWith("0x") ? s.signature : `0x${s.signature}`) as `0x${string}`;
    const signer = await recoverMessageAddress({ message: signedText, signature: hex });
    if (signer.toLowerCase() !== s.signing_address.toLowerCase()) {
      return { state: "failed", reason: "the signature was not made by the signing address in the report", signedText };
    }
    return { state: "verified", signer, signedText };
  } catch {
    return { state: "failed", reason: "the signature is malformed", signedText };
  }
}

export async function verifyPublishedReport(reportText: string): Promise<ReportVerification> {
  const hash = bytesToHex(sha256(utf8ToBytes(reportText)));
  const fail = (problem: string): ReportVerification => ({ report: null, sha256: hash, canonical: false, problem, ai: null, attestationVerified: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch {
    return fail("The report is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== REPORT_SCHEMA) {
    return fail(`The report is not a ${REPORT_SCHEMA} document`);
  }
  const report = parsed as AttestedReport;
  let ai: AiSignatureResult;
  try {
    ai = await checkAiSignature(report.ai ?? null);
  } catch {
    return fail("The report's AI section is malformed");
  }
  return {
    report,
    sha256: hash,
    canonical: canonicalJson(parsed) === reportText,
    ai,
    attestationVerified: report.ai?.attestation?.verified === true,
  };
}
