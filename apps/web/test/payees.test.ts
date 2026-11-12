import { describe, expect, it } from "vitest";
import { parseCsv } from "@blindroll/core";
import { buildPayeeCsv } from "../lib/client/payees";

describe("add-a-payee CSV", () => {
  it("round-trips through the same CSV parser as an uploaded file, quoting what needs it", () => {
    const csv = buildPayeeCsv([
      { name: "Asha, R.", wallet: "asha.testnet", amount: "1,200.50", memo: 'Said "thanks"' },
      { name: "Ben", wallet: "0x8ba1f109551bd432803012645ac136ddd64dba72", amount: "800", memo: "" },
    ]);
    const parsed = parseCsv(new TextEncoder().encode(csv));
    expect(parsed.headers).toEqual(["Name", "Wallet", "Amount (USDC)", "Memo"]);
    expect(parsed.rows).toHaveLength(2);
    expect(JSON.stringify(parsed.rows[0])).toContain("Asha, R.");
    expect(JSON.stringify(parsed.rows[0])).toContain("1,200.50");
    expect(JSON.stringify(parsed.rows[0])).toContain('Said \\"thanks\\"');
  });
});
