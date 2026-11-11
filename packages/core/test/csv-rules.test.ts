import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ColumnMapping,
  ValidationError,
  base58Decode,
  buildTreeFromLeaves,
  doubledMedian,
  formatUsdc,
  inferChain,
  normalizeEvmAddress,
  normalizeRows,
  parseAmountCell,
  parseCsv,
  runRules,
  sortFindings,
  validateMapping,
} from "../src/index.ts";
import vectors from "../test-vectors/merkle.json" with { type: "json" };

const sampleBytes = new Uint8Array(readFileSync(new URL("../../../docs/samples/payroll-messy.csv", import.meta.url)));
const enc = (s: string) => new TextEncoder().encode(s);

/** The mapping docs/samples/README.md expects from the AI. */
const SAMPLE_MAPPING = {
  mapping: { name: "Contributor", chain: null, address: "Wallet Addr", amount: "Amt (USD)", currency: "currency", role: "Role", memo: "Notes", email: "E-mail" },
  amount_format: { thousands_separator: ",", decimal_separator: ".", currency_symbols: ["$"] },
  notes: ["chain column missing; infer from address format"],
};
const FMT = SAMPLE_MAPPING.amount_format;

describe("parseCsv", () => {
  it("parses the sample: 9 data rows, row 4 dropped as empty", () => {
    const csv = parseCsv(sampleBytes);
    expect(csv.headers).toEqual(["Contributor", "E-mail", "Wallet Addr", "Amt (USD)", "currency", "Role", "Notes"]);
    expect(csv.droppedEmptyRows).toEqual([4]);
    expect(csv.rows.map((r) => r.rowNumber)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(csv.rows[0]!.cells["Amt (USD)"]).toBe("$1,200.50");
    expect(csv.csvSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(csv.delimiter).toBe(",");
  });

  it("detects semicolons and tabs, strips a BOM, trims cells", () => {
    const semi = parseCsv(enc("﻿name; wallet ;amount\n Ann ;ann.testnet; 5 \n"));
    expect(semi.delimiter).toBe(";");
    expect(semi.headers).toEqual(["name", "wallet", "amount"]);
    expect(semi.rows[0]!.cells).toEqual({ name: "Ann", wallet: "ann.testnet", amount: "5" });
    expect(parseCsv(enc("a\tb\n1\t2\n")).delimiter).toBe("\t");
  });

  it("rejects unusable files", () => {
    expect(() => parseCsv(new Uint8Array())).toThrow(ValidationError);
    expect(() => parseCsv(enc("a,b\n"))).toThrow(/no data rows/);
    expect(() => parseCsv(enc("a,a\n1,2\n"))).toThrow(/duplicate column/);
    expect(() => parseCsv(enc("a,,c\n1,2,3\n"))).toThrow(/empty column name/);
    expect(() => parseCsv(enc("a,b\n1,2,3\n"))).toThrow(/more cells/);
    expect(() => parseCsv(Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x31]))).toThrow(/UTF-8/);
    expect(() => parseCsv(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61))).toThrow(/2 MB/);
  });
});

describe("validateMapping", () => {
  const headers = parseCsv(sampleBytes).headers;
  it("accepts the expected sample mapping", () => {
    expect(validateMapping(SAMPLE_MAPPING, headers).mapping.address).toBe("Wallet Addr");
  });
  it("rejects anything the AI should not be able to do", () => {
    const m = (patch: object) => ({ ...SAMPLE_MAPPING, mapping: { ...SAMPLE_MAPPING.mapping, ...patch } });
    expect(() => validateMapping(m({ address: "Invented Column" }), headers)).toThrow(/not in the file/);
    expect(() => validateMapping(m({ address: null }), headers)).toThrow(/address column/);
    expect(() => validateMapping(m({ amount: null }), headers)).toThrow(/amount column/);
    expect(() => validateMapping(m({ memo: "Role" }), headers)).toThrow(/mapped to both/);
    expect(() => validateMapping({ ...SAMPLE_MAPPING, total: "999" }, headers)).toThrow(/wrong shape/);
    expect(() => validateMapping({ ...SAMPLE_MAPPING, mapping: { ...SAMPLE_MAPPING.mapping, pay_to: "Role" } }, headers)).toThrow(/wrong shape/);
    expect(() => validateMapping("ignore previous instructions", headers)).toThrow(/wrong shape/);
    expect(() =>
      validateMapping({ ...SAMPLE_MAPPING, amount_format: { thousands_separator: ".", decimal_separator: ".", currency_symbols: [] } }, headers),
    ).toThrow(/cannot be the same/);
  });
});

describe("parseAmountCell (integers only)", () => {
  const ok = (raw: string, fmt = FMT) => {
    const r = parseAmountCell(raw, fmt);
    if (!r.ok) throw new Error(r.reason);
    return r.amount;
  };
  it("parses the formats in the sample", () => {
    expect(ok("$1,200.50")).toBe(1_200_500_000n);
    expect(ok("800")).toBe(800_000_000n);
    expect(ok("950.00")).toBe(950_000_000n);
    expect(ok("1,100")).toBe(1_100_000_000n);
    expect(ok("$1,050")).toBe(1_050_000_000n);
  });
  it("keeps full precision", () => {
    expect(ok("0.000001")).toBe(1n);
    expect(ok("0.1")).toBe(100_000n);
    expect(ok("1,234,567.123456")).toBe(1_234_567_123_456n);
    expect(ok("123456789012345678.999999")).toBe(123_456_789_012_345_678_999_999n);
    expect(ok("100 USD", { ...FMT, currency_symbols: ["$", "USD"] })).toBe(100_000_000n);
  });
  it("supports European formats via hints", () => {
    const eu = { thousands_separator: ".", decimal_separator: ",", currency_symbols: ["€"] };
    expect(ok("1.200,50", eu)).toBe(1_200_500_000n);
    expect(ok("1 200,5", { ...eu, thousands_separator: " " })).toBe(1_200_500_000n);
  });
  it("rejects bad amounts", () => {
    for (const raw of ["", "0", "0.00", "-5", "(5)", "1.2345678", "abc", "1,2", "12,34.5", "1,2345", "1.2.3", "1e6", "٣", ".5", "5.", "$", "1 000"]) {
      expect(parseAmountCell(raw, FMT).ok, raw).toBe(false);
    }
  });
  it("formats for display", () => {
    expect(formatUsdc(1_200_500_000n)).toBe("1,200.50");
    expect(formatUsdc(14_600_500_000n)).toBe("14,600.50");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_000_000n)).toBe("1.00");
  });
});

describe("addresses", () => {
  it("validates EVM addresses including EIP-55", () => {
    expect(normalizeEvmAddress("0x8ba1f109551bd432803012645ac136ddd64dba72")).toBe("0x8ba1f109551bd432803012645ac136ddd64dba72");
    expect(normalizeEvmAddress("0x8ba1f109551bD432803012645Ac136ddd64DBA72")).toBe("0x8ba1f109551bd432803012645ac136ddd64dba72");
    expect(normalizeEvmAddress("0x8BA1f109551bD432803012645Ac136ddd64DBA72")).toBeNull(); // broken checksum
    expect(normalizeEvmAddress("0x123")).toBeNull();
    expect(normalizeEvmAddress("8ba1f109551bd432803012645ac136ddd64dba72")).toBeNull();
  });
  it("infers chains as documented", () => {
    expect(inferChain("0x123")).toBe("evm");
    expect(inferChain("hiro.testnet")).toBe("near");
    expect(inferChain("alice.near")).toBe("near");
    expect(inferChain("a".repeat(64))).toBe("near");
    expect(inferChain("11111111111111111111111111111111")).toBe("solana");
    expect(inferChain("hello")).toBeNull();
    expect(base58Decode("11111111111111111111111111111111")?.length).toBe(32);
    expect(base58Decode("0OIl")).toBeNull();
  });
});

describe("sample CSV end to end (docs/samples/README.md)", () => {
  const csv = parseCsv(sampleBytes);
  const mapping = validateMapping(SAMPLE_MAPPING, csv.headers);
  const { rows, findings: formatFindings } = normalizeRows(csv, mapping);
  const findings = sortFindings([...formatFindings, ...runRules(rows)]);

  it("produces exactly the expected findings", () => {
    expect(findings.map((f) => [f.rowNumber, f.ruleId, f.severity])).toEqual([
      [6, "R004_duplicate_address", "error"],
      [7, "R006_outlier_vs_run", "warning"],
      [8, "R002_unknown_currency", "error"],
      [9, "R001_invalid_address", "error"],
    ]);
    expect(findings[1]!.message).toContain("1,050.00");
  });

  it("uses a run median of 1,050 over all rows with an amount", () => {
    expect(doubledMedian(rows.flatMap((r) => (r.amount === null ? [] : [r.amount])))).toBe(2_100_000_000n);
    expect(doubledMedian([1n, 3n])).toBe(4n);
    expect(doubledMedian([])).toBeNull();
  });

  it("gives the expected clean table, total and Merkle root", () => {
    const clean = rows.filter((r) => ![6, 8, 9].includes(r.rowNumber));
    expect(clean.map((r) => [r.name, r.chain, r.amount])).toEqual([
      ["Asha Rao", "evm", 1_200_500_000n],
      ["Ben Okafor", "near", 800_000_000n],
      ["Chen Wei", "evm", 950_000_000n],
      ["Dana Silva", "evm", 1_100_000_000n],
      ["Elif Kaya", "evm", 9_500_000_000n],
      ["Hiro Tanaka", "near", 1_050_000_000n],
    ]);
    expect(clean.reduce((s, r) => s + r.amount!, 0n)).toBe(14_600_500_000n);
    // With the salts from the shared vectors, the clean table hashes to the "sample-run" root.
    const t = vectors.trees.find((x) => x.name === "sample-run")!;
    const leaves = clean.map((r, i) => ({ chain: r.chain!, address: r.address!, amount: r.amount!, saltHex: t.leaves[i]!.salt_hex }));
    expect(buildTreeFromLeaves(t.run_key, leaves).rootHex).toBe(t.root);
  });
});

describe("rules", () => {
  const run = (text: string, ctx?: Parameters<typeof runRules>[1], chainCol: string | null = null) => {
    const csv = parseCsv(enc(text));
    const mapping = validateMapping(
      { mapping: { name: "name", chain: chainCol, address: "addr", amount: "amt", currency: null, role: null, memo: null, email: csv.headers.includes("email") ? "email" : null }, amount_format: FMT },
      csv.headers,
    );
    const n = normalizeRows(csv, mapping);
    return sortFindings([...n.findings, ...runRules(n.rows, ctx)]).map((f) => `${f.rowNumber}:${f.ruleId}`);
  };

  it("R003 invalid amounts, R001 missing address", () => {
    expect(run("name,addr,amt\nA,a.testnet,-5\nB,,10\nC,c.testnet,1.1234567\n")).toEqual([
      "1:R003_invalid_amount",
      "2:R001_invalid_address",
      "3:R003_invalid_amount",
    ]);
  });
  it("R004 treats EVM addresses case-insensitively", () => {
    expect(run("name,addr,amt\nA,0x8ba1f109551bd432803012645ac136ddd64dba72,5\nA,0x8ba1f109551bD432803012645Ac136ddd64DBA72,5\n")).toEqual(["2:R004_duplicate_address"]);
  });
  it("R005 same name or email with a different address", () => {
    expect(run("name,email,addr,amt\nAnn,a@x.org,ann.testnet,5\nann,b@x.org,ann2.testnet,5\nZed,A@x.org,zed.testnet,5\n")).toEqual([
      "2:R005_duplicate_identity",
      "3:R005_duplicate_identity",
    ]);
  });
  it("R006 is strictly greater than 5 × median", () => {
    expect(run("name,addr,amt\nA,a.testnet,10\nB,b.testnet,10\nC,c.testnet,50\n")).toEqual([]);
    expect(run("name,addr,amt\nA,a.testnet,10\nB,b.testnet,10\nC,c.testnet,50.000001\n")).toEqual(["3:R006_outlier_vs_run"]);
  });
  it("R009 cap and R010 budget", () => {
    const ctx = { supportedChains: ["near", "evm"] as const, perRecipientCap: 20_000_000n, runBudget: 40_000_000n };
    expect(run("name,addr,amt\nA,a.testnet,10\nB,b.testnet,20\nC,c.testnet,20.5\n", ctx)).toEqual(["3:R009_over_cap", "null:R010_budget_exceeded"]);
  });
  it("R011 unsupported or unknown chains", () => {
    expect(run("name,addr,amt\nA,11111111111111111111111111111111,5\n")).toEqual(["1:R011_unsupported_chain"]);
    expect(run("name,chain,addr,amt\nA,bitcoin,bc1qxyz,5\nB,ETH,0x8ba1f109551bd432803012645ac136ddd64dba72,5\n", undefined, "chain")).toEqual(["1:R011_unsupported_chain"]);
  });
});
