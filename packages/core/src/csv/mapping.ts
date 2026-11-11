import { z } from "zod";
import { ValidationError } from "../validate.ts";

export const MAPPING_FIELDS = ["name", "chain", "address", "amount", "currency", "role", "memo", "email"] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];

const column = z.string().min(1).max(200).nullable();
const separator = z.enum([",", ".", " ", "'", ""]).nullable();

/** The only thing the AI is allowed to return: which source column feeds which field. */
export const ColumnMappingSchema = z
  .object({
    mapping: z
      .object({
        name: column,
        chain: column,
        address: column,
        amount: column,
        currency: column,
        role: column,
        memo: column,
        email: column,
      })
      .strict(),
    amount_format: z
      .object({
        thousands_separator: separator,
        decimal_separator: z.enum([".", ","]).nullable(),
        currency_symbols: z.array(z.string().min(1).max(8)).max(10),
      })
      .strict(),
    notes: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();

export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/**
 * Checks a mapping (from the AI or typed by the approver) against the real headers.
 * Code decides: unknown columns, a missing address/amount column or one column used twice are rejected.
 */
export function validateMapping(input: unknown, headers: string[]): ColumnMapping {
  const parsed = ColumnMappingSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(`Column mapping has the wrong shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const m = parsed.data;
  const used = new Map<string, string>();
  for (const field of MAPPING_FIELDS) {
    const col = m.mapping[field];
    if (col === null) continue;
    if (!headers.includes(col)) throw new ValidationError(`Column mapping names a column that is not in the file: "${col}"`);
    const other = used.get(col);
    if (other) throw new ValidationError(`Column "${col}" is mapped to both ${other} and ${field}`);
    used.set(col, field);
  }
  if (m.mapping.address === null) throw new ValidationError("Column mapping needs an address column");
  if (m.mapping.amount === null) throw new ValidationError("Column mapping needs an amount column");
  const f = m.amount_format;
  if (f.thousands_separator && f.thousands_separator === (f.decimal_separator ?? ".")) {
    throw new ValidationError("Thousands and decimal separators cannot be the same");
  }
  return m;
}
