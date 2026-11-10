import { describe, expect, it } from "vitest";
import { ValidationError, assertNetworkConfig, isTestNetworkAccount } from "../src/index.js";

describe("network config guard", () => {
  it("accepts testnet and sandbox setups with the mock token", () => {
    assertNetworkConfig({ network: "testnet", contractId: "blindroll.me.testnet", tokenId: "usdc.me.testnet" });
    assertNetworkConfig({ network: "sandbox", contractId: "blindroll.test.near", tokenId: "usdc.test.near" });
  });
  it("accepts a mainnet setup with a mainnet token", () => {
    assertNetworkConfig({ network: "mainnet", contractId: "blindroll.near", tokenId: "usdc-token.near" });
  });
  it("refuses the mock token or test accounts on mainnet", () => {
    for (const tokenId of ["usdc.me.testnet", "usdc.test.near", "usdc.sandbox"]) {
      expect(() => assertNetworkConfig({ network: "mainnet", contractId: "blindroll.near", tokenId })).toThrow(ValidationError);
    }
    expect(() =>
      assertNetworkConfig({ network: "mainnet", contractId: "blindroll.me.testnet", tokenId: "usdc-token.near" }),
    ).toThrow(ValidationError);
  });
  it("refuses unknown networks and malformed IDs", () => {
    expect(() => assertNetworkConfig({ network: "prod", contractId: "a.near", tokenId: "b.near" })).toThrow(ValidationError);
    expect(() => assertNetworkConfig({ network: "testnet", contractId: "Bad ID", tokenId: "b.testnet" })).toThrow(ValidationError);
  });
  it("uses the same suffix list as the mock-usdc contract", () => {
    expect(isTestNetworkAccount("usdc.near")).toBe(false);
    expect(isTestNetworkAccount("testnet.near")).toBe(false);
    expect(isTestNetworkAccount("usdc.me.testnet")).toBe(true);
  });
});
