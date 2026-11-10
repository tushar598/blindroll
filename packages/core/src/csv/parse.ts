import Papa from "papaparse";
import { bytesToHex, sha256 } from "../hash.js";
import { ValidationError } from "../validate.js";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;

export interface RawRow {
  /** 1-based position among the data rows of the file (header excluded, empty rows counted). */
  rowNumber: number;
  /** Trimmed cell text by header name. */
  cells: Record<string, string>;
}

export interface ParsedCsv {
  /** sha256 of the exact uploaded bytes, lowercase hex. */
  csvSha256: string;
  delimiter: string;
  headers: string[];
  /** Non-empty data rows. */
  rows: RawRow[];
  /** Row numbers of data rows that were empty and dropped. */
  droppedEmptyRows: number[];
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Picks the candidate that occurs most often outside quotes in the header line (default ","). */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: string = ",";
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Parses uploaded CSV bytes: detects the delimiter from the header line, trims every cell and drops empty rows.
 * The first non-empty line is the header. Headers must be non-empty and unique.
 */
export function parseCsv(bytes: Uint8Array): ParsedCsv {
  if (bytes.length === 0) throw new ValidationError("The CSV file is empty");
  if (bytes.length > MAX_CSV_BYTES) throw new ValidationError("The CSV file is larger than 2 MB");
  const csvSha256 = bytesToHex(sha256(bytes));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("The CSV file is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const result = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false, delimiter: detectDelimiter(text) });
  const fatal = result.errors.find((e) => e.type === "Quotes");
  if (fatal) throw new ValidationError(`CSV parse error on line ${(fatal.row ?? 0) + 1}: ${fatal.message}`);

  const table = result.data.map((r) => r.map((c) => (c ?? "").trim()));
  const isEmpty = (r: string[]) => r.every((c) => c === "");
  const headerIndex = table.findIndex((r) => !isEmpty(r));
  if (headerIndex === -1) throw new ValidationError("The CSV file has no header row");
  const headers = table[headerIndex]!;
  if (headers.some((h) => h === "")) throw new ValidationError("The CSV header has an empty column name");
  if (new Set(headers).size !== headers.length) throw new ValidationError("The CSV header has duplicate column names");

  const dataRows = table.slice(headerIndex + 1);
  // A trailing newline produces one last empty record; it is not a data row.
  while (dataRows.length > 0 && isEmpty(dataRows[dataRows.length - 1]!)) dataRows.pop();
  if (dataRows.length > MAX_CSV_ROWS) throw new ValidationError(`The CSV file has more than ${MAX_CSV_ROWS} rows`);

  const rows: RawRow[] = [];
  const droppedEmptyRows: number[] = [];
  dataRows.forEach((r, i) => {
    const rowNumber = i + 1;
    if (isEmpty(r)) {
      droppedEmptyRows.push(rowNumber);
      return;
    }
    if (r.length > headers.length && r.slice(headers.length).some((c) => c !== "")) {
      throw new ValidationError(`Row ${rowNumber} has more cells than the header has columns`);
    }
    const cells: Record<string, string> = {};
    headers.forEach((h, j) => {
      cells[h] = r[j] ?? "";
    });
    rows.push({ rowNumber, cells });
  });
  if (rows.length === 0) throw new ValidationError("The CSV file has no data rows");
  return { csvSha256, delimiter: result.meta.delimiter, headers, rows, droppedEmptyRows };
}
