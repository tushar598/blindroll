import { U128_MAX } from "../validate.js";

export const USDC_DECIMALS = 6;

export interface AmountFormat {
  thousands_separator: string | null;
  decimal_separator: string | null;
  currency_symbols: string[];
}

export type AmountResult = { ok: true; amount: bigint } | { ok: false; reason: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses a human-typed amount into USDC base units (6 decimals) using integer math only.
 * Rejects negative, zero, more than 6 decimal places and misplaced thousands separators.
 */
export function parseAmountCell(raw: string, format: AmountFormat): AmountResult {
  let s = raw.trim();
  if (s === "") return { ok: false, reason: "amount is empty" };
  for (const sym of [...format.currency_symbols].sort((a, b) => b.length - a.length)) {
    if (s.startsWith(sym)) s = s.slice(sym.length).trim();
    else if (s.endsWith(sym)) s = s.slice(0, -sym.length).trim();
  }
  if (s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"))) return { ok: false, reason: "amount is negative" };

  const dec = format.decimal_separator ?? ".";
  const thou = format.thousands_separator ?? "";
  const parts = s.split(dec);
  if (parts.length > 2) return { ok: false, reason: "amount has more than one decimal separator" };
  let whole = parts[0] ?? "";
  const frac = parts[1] ?? "";
  if (thou !== "" && whole.includes(thou)) {
    const grouped = new RegExp(`^\\d{1,3}(${escapeRe(thou)}\\d{3})+$`);
    if (!grouped.test(whole)) return { ok: false, reason: "amount has a misplaced thousands separator" };
    whole = whole.split(thou).join("");
  }
  if (!/^\d+$/.test(whole) || (parts.length === 2 && !/^\d+$/.test(frac))) {
    return { ok: false, reason: "amount is not a number" };
  }
  if (frac.length > USDC_DECIMALS) return { ok: false, reason: "amount has more than 6 decimal places" };
  if (whole.length > 30) return { ok: false, reason: "amount is too large" };
  const amount = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  if (amount === 0n) return { ok: false, reason: "amount is zero" };
  if (amount > U128_MAX) return { ok: false, reason: "amount is too large" };
  return { ok: true, amount };
}

/** "1200500000" base units → "1,200.50" for display. Never used for hashing. */
export function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}
