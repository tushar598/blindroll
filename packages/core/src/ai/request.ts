import type { ParsedCsv } from "../csv/parse.js";
import { MAPPING_SYSTEM_PROMPT } from "./prompts.js";

/** Sample rows sent to the model: the header plus at most this many data rows (docs/05). */
export const MAX_SAMPLE_ROWS = 5;
export const MAPPING_MAX_TOKENS = 1500;

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** `asha@example.org` → `a***@example.org`. Applied to every cell before it leaves the server. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, "$1***@$2");
}

/** Header + up to 5 masked sample rows, as JSON the model can read without CSV quoting rules. */
export function buildMappingSample(csv: ParsedCsv): { headers: string[]; sample_rows: string[][] } {
  return {
    headers: csv.headers,
    sample_rows: csv.rows.slice(0, MAX_SAMPLE_ROWS).map((r) => csv.headers.map((h) => maskEmails(r.cells[h] ?? ""))),
  };
}

/**
 * The exact request body for the mapping call. The returned string is what gets sent AND hashed:
 * never re-serialize it (the TEE signature covers sha256 of these bytes).
 */
export function buildMappingRequestBody(csv: ParsedCsv, model: string): string {
  return JSON.stringify({
    model,
    temperature: 0,
    stream: false,
    max_tokens: MAPPING_MAX_TOKENS,
    messages: [
      { role: "system", content: MAPPING_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(buildMappingSample(csv)) },
    ],
  });
}
