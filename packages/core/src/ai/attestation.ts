/**
 * Offline checks on the NEAR AI Cloud attestation stored for a run (docs/05 "Attestation checks").
 * Pure and browser-safe: the verify page runs them on the raw attestation text whose sha256 the
 * on-chain report hash commits to.
 *
 * What this proves, and what it does not:
 * - It checks that the attestation document is the one the report names, that the key which
 *   signed the AI response is the one in the model's attestation, that the TDX quote's
 *   report_data binds that key and our nonce, and that the quote's RTMR3 and MRCONFIGID match
 *   the event log and compose hash shipped with it.
 * - It does NOT verify the Intel TDX quote's signature chain (DCAP) or the NVIDIA GPU evidence.
 *   Until the quote signature is verified, the checks above show internal consistency only:
 *   they do not prove the quote came from real TDX hardware.
 */
import { sha256 as nobleSha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export type EvidenceState = "pass" | "fail" | "not_verified";

export type EvidenceCheckId =
  | "attestation_document"
  | "signer_attested"
  | "quote_binds_signer_nonce"
  | "rtmr3_event_log"
  | "mrconfigid_compose_hash"
  | "intel_quote_signature"
  | "nvidia_gpu_evidence";

export interface EvidenceCheck {
  id: EvidenceCheckId;
  title: string;
  state: EvidenceState;
  /** One line: what was compared, or why it could not be. */
  detail: string;
}

export interface AttestationEvidenceInput {
  /** The report's `ai` section (only the fields read here). */
  ai: {
    model: string;
    signature: { algo: string; signing_address: string } | null;
    attestation: { nonce: string; sha256: string };
  };
  /** The raw attestation text as served, or null when it could not be loaded. */
  attestationText: string | null;
}

export interface AttestationEvidence {
  checks: EvidenceCheck[];
  passed: number;
  failed: number;
  notVerified: number;
  /** True only if every check passed. Never true today: DCAP and GPU checks are not implemented. */
  fullyVerified: boolean;
}

interface EventLogEntry {
  imr: number;
  event_type: number;
  digest?: string;
  event?: string;
  event_payload?: string;
}
interface ModelReport {
  model_name?: string;
  signing_address?: string;
  signing_algo?: string;
  request_nonce?: string;
  intel_quote?: string;
  event_log?: EventLogEntry[] | string;
  nvidia_payload?: string;
  info?: { compose_hash?: string; tcb_info?: string | { app_compose?: string } };
}

/** TDX v4 quote layout: 48-byte header, then the TD report body (offsets inside the body). */
const HEADER = 48;
const MRCONFIGID = HEADER + 184;
const RTMR3 = HEADER + 472;
const REPORT_DATA = HEADER + 520;
const QUOTE_MIN = REPORT_DATA + 64;

const NOT_DCAP =
  "consistency only until the Intel quote signature is verified (see the DCAP check below)";

function tdxBody(quoteHex: string | undefined): Uint8Array | string {
  if (!quoteHex) return "the model report has no intel_quote";
  let q: Uint8Array;
  try {
    q = hexToBytes(quoteHex);
  } catch {
    return "intel_quote is not hex";
  }
  if (q.length < QUOTE_MIN) return "intel_quote is too short for a TDX v4 quote";
  const version = q[0]! | (q[1]! << 8);
  const teeType = q[4]! | (q[5]! << 8) | (q[6]! << 16) | (q[7]! << 24);
  if (version !== 4 || teeType !== 0x81) return `not a TDX v4 quote (version ${version}, TEE type 0x${teeType.toString(16)})`;
  return q;
}

/** dstack runtime event digest: sha384(le32(event_type) ‖ ":" ‖ event ‖ ":" ‖ payload). */
function eventDigest(e: EventLogEntry): Uint8Array {
  const t = new Uint8Array(4);
  new DataView(t.buffer).setUint32(0, e.event_type >>> 0, true);
  const colon = utf8ToBytes(":");
  return sha384(concatBytes(t, colon, utf8ToBytes(e.event ?? ""), colon, hexToBytes(e.event_payload ?? "")));
}

function parseEventLog(raw: ModelReport["event_log"]): EventLogEntry[] | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as EventLogEntry[]) : null;
  } catch {
    return null;
  }
}

/** Replays the RTMR3 events; returns the final register value, or an error message. */
export function replayRtmr3(events: EventLogEntry[]): Uint8Array | string {
  let r: Uint8Array = new Uint8Array(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    let d: Uint8Array;
    try {
      d = eventDigest(e);
    } catch {
      return `event "${e.event ?? "?"}" has a malformed payload`;
    }
    if (e.digest && e.digest.toLowerCase() !== bytesToHex(d)) return `event "${e.event ?? "?"}" carries a digest that does not match its payload`;
    r = sha384(concatBytes(r, d));
  }
  return r;
}

function check(id: EvidenceCheckId, title: string, state: EvidenceState, detail: string): EvidenceCheck {
  return { id, title, state, detail };
}

export function checkAttestationEvidence(input: AttestationEvidenceInput): AttestationEvidence {
  const { ai, attestationText } = input;
  const checks: EvidenceCheck[] = [];
  const T = {
    doc: "Attestation document matches the report",
    signer: "Response signer is the attested model key",
    bind: "TDX quote binds the signer and our nonce",
    rtmr3: "Event log replays to the quote's RTMR3",
    mrcfg: "Quote's MRCONFIGID matches the compose hash",
    dcap: "Intel TDX quote signature (DCAP)",
    gpu: "NVIDIA GPU evidence",
  };
  const dcap = check(
    "intel_quote_signature", T.dcap, "not_verified",
    "Not verified here. It needs an Intel DCAP verifier (for example dcap-qvl) and Intel's current collateral; this version does not include one.",
  );
  const finish = (gpu: EvidenceCheck): AttestationEvidence => {
    checks.push(dcap, gpu);
    const count = (s: EvidenceState) => checks.filter((c) => c.state === s).length;
    return { checks, passed: count("pass"), failed: count("fail"), notVerified: count("not_verified"), fullyVerified: checks.every((c) => c.state === "pass") };
  };
  const gpuNotVerified = (extra: string) =>
    check("nvidia_gpu_evidence", T.gpu, "not_verified", `Not verified: checking it needs NVIDIA's attestation verifier.${extra}`);
  const skipRest = (why: string) => {
    for (const [id, title] of [["signer_attested", T.signer], ["quote_binds_signer_nonce", T.bind], ["rtmr3_event_log", T.rtmr3], ["mrconfigid_compose_hash", T.mrcfg]] as const) {
      if (!checks.some((c) => c.id === id)) checks.push(check(id, title, "not_verified", `Not checked: ${why}.`));
    }
    return finish(gpuNotVerified(""));
  };

  // 1. The served document is the one the on-chain report hash commits to.
  if (attestationText === null) {
    checks.push(check("attestation_document", T.doc, "fail", "The stored attestation could not be loaded."));
    return skipRest("no attestation document");
  }
  const docHash = bytesToHex(nobleSha256(utf8ToBytes(attestationText)));
  if (docHash !== ai.attestation.sha256.toLowerCase()) {
    checks.push(check("attestation_document", T.doc, "fail", `sha256 of the served document is ${docHash}; the report says ${ai.attestation.sha256}.`));
    return skipRest("the document is not the one the report names");
  }
  let doc: { model_attestations?: ModelReport[] };
  try {
    doc = JSON.parse(attestationText);
  } catch {
    checks.push(check("attestation_document", T.doc, "fail", "The document's sha256 matches, but it is not valid JSON."));
    return skipRest("the document is not JSON");
  }
  checks.push(check("attestation_document", T.doc, "pass", `sha256 ${docHash} equals ai.attestation.sha256 in the report (the report hash is on-chain).`));

  // 2. Exactly one model report carries the key that signed the response.
  if (!ai.signature) return skipRest("the report holds no AI signature");
  const signer = ai.signature.signing_address.toLowerCase();
  const matches = (doc.model_attestations ?? []).filter(
    (m) => m.signing_algo === ai.signature!.algo && m.signing_address?.toLowerCase() === signer,
  );
  const m = matches.length === 1 ? matches[0]! : null;
  if (!m) {
    checks.push(check("signer_attested", T.signer, "fail", `${matches.length} model attestations list ${signer} with ${ai.signature.algo}; exactly 1 is required.`));
    return skipRest("the signer is not in exactly one model attestation");
  }
  if (m.model_name !== undefined && m.model_name !== ai.model) {
    checks.push(check("signer_attested", T.signer, "fail", `The matching attestation is for model ${m.model_name}, not ${ai.model}.`));
    return skipRest("the attestation is for another model");
  }
  checks.push(check("signer_attested", T.signer, "pass", `The ${ai.model} attestation lists signing_address ${signer} (${ai.signature.algo}), the address that signed the response.`));

  const nonce = ai.attestation.nonce.toLowerCase();
  const gpu = (() => {
    if (!m.nvidia_payload) return gpuNotVerified(" The model report has no nvidia_payload.");
    try {
      const n = (JSON.parse(m.nvidia_payload) as { nonce?: string }).nonce?.toLowerCase();
      return gpuNotVerified(n === nonce ? " The payload is present and echoes our nonce." : " The payload is present but does not echo our nonce.");
    } catch {
      return gpuNotVerified(" The payload is present but is not JSON.");
    }
  })();

  // 3. report_data = signing address (20 bytes) ‖ 12 zero bytes ‖ nonce (32 bytes) (docs/05).
  const body = tdxBody(m.intel_quote);
  if (typeof body === "string") {
    for (const [id, title] of [["quote_binds_signer_nonce", T.bind], ["rtmr3_event_log", T.rtmr3], ["mrconfigid_compose_hash", T.mrcfg]] as const) {
      checks.push(check(id, title, "fail", `The quote cannot be read: ${body}.`));
    }
    return finish(gpu);
  }
  const reportData = bytesToHex(body.slice(REPORT_DATA, REPORT_DATA + 64));
  const expected = `${signer.replace(/^0x/, "")}${"00".repeat(12)}${nonce}`;
  const echoed = m.request_nonce?.toLowerCase() === nonce;
  checks.push(
    reportData === expected && echoed
      ? check("quote_binds_signer_nonce", T.bind, "pass", `report_data = signer ‖ 12 zero bytes ‖ nonce ${nonce.slice(0, 12)}…, and request_nonce echoes it; ${NOT_DCAP}.`)
      : check("quote_binds_signer_nonce", T.bind, "fail", !echoed ? "The model report's request_nonce differs from the nonce in the report." : `report_data is ${reportData}, expected ${expected}.`),
  );

  // 4. RTMR3 replay from the event log.
  const events = parseEventLog(m.event_log);
  const rtmr3 = bytesToHex(body.slice(RTMR3, RTMR3 + 48));
  if (!events) {
    checks.push(check("rtmr3_event_log", T.rtmr3, "fail", "The model report has no readable event_log."));
  } else {
    const replayed = replayRtmr3(events);
    checks.push(
      typeof replayed === "string"
        ? check("rtmr3_event_log", T.rtmr3, "fail", `Replay failed: ${replayed}.`)
        : bytesToHex(replayed) === rtmr3
          ? check("rtmr3_event_log", T.rtmr3, "pass", `Replaying ${events.filter((e) => e.imr === 3).length} RTMR3 events gives the quote's RTMR3 ${rtmr3.slice(0, 12)}…; ${NOT_DCAP}.`)
          : check("rtmr3_event_log", T.rtmr3, "fail", `Replay gives ${bytesToHex(replayed).slice(0, 16)}…, the quote has ${rtmr3.slice(0, 16)}….`),
    );
  }

  // 5. MRCONFIGID = 0x01 ‖ compose_hash ‖ 15 zero bytes, and the RTMR3 compose-hash event agrees.
  const composeHash = m.info?.compose_hash?.toLowerCase();
  const mrConfigId = bytesToHex(body.slice(MRCONFIGID, MRCONFIGID + 48));
  if (!composeHash) {
    checks.push(check("mrconfigid_compose_hash", T.mrcfg, "fail", "The model report has no info.compose_hash."));
  } else {
    const eventHash = events?.find((e) => e.imr === 3 && e.event === "compose-hash")?.event_payload?.toLowerCase();
    let appCompose: string | undefined;
    try {
      const tcb = m.info?.tcb_info;
      appCompose = (typeof tcb === "string" ? JSON.parse(tcb) : tcb)?.app_compose;
    } catch {
      appCompose = undefined;
    }
    const composeOk = appCompose === undefined || bytesToHex(nobleSha256(utf8ToBytes(appCompose))) === composeHash;
    const ok = mrConfigId === `01${composeHash}${"00".repeat(15)}` && (eventHash === undefined || eventHash === composeHash) && composeOk;
    checks.push(
      ok
        ? check(
            "mrconfigid_compose_hash", T.mrcfg, "pass",
            `MRCONFIGID = 01 ‖ compose_hash ${composeHash.slice(0, 12)}… ‖ zeros${eventHash ? ", matching the compose-hash event" : ""}. ${appCompose === undefined ? "The model report does not include app_compose, so the compose file itself is not checked" : "sha256(app_compose) matches"}; ${NOT_DCAP}.`,
          )
        : check("mrconfigid_compose_hash", T.mrcfg, "fail", !composeOk ? "sha256(app_compose) differs from compose_hash." : `MRCONFIGID ${mrConfigId.slice(0, 20)}… does not match compose_hash ${composeHash.slice(0, 12)}…${eventHash && eventHash !== composeHash ? " (and the compose-hash event differs)" : ""}.`),
    );
  }
  return finish(gpu);
}
