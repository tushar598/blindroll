import { describe, expect, it } from "vitest";
import { ValidationError, assertNetworkConfig, isTestNetworkAccount } from "../src/index.ts";

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

describe("sim sink guard", () => {
  const base = { network: "testnet", contractId: "blindroll.blindroll-dev.testnet", tokenId: "usdc.blindroll-dev.testnet" };
  it("allows a test account on a test network", () => {
    expect(() => assertNetworkConfig({ ...base, simSinkId: "sim-sink.blindroll-dev.testnet" })).not.toThrow();
    expect(() => assertNetworkConfig({ ...base, simSinkId: "" })).not.toThrow();
  });
  it("refuses any sim sink on mainnet", () => {
    const main = { network: "mainnet", contractId: "blindroll.near", tokenId: "usdc.near" };
    expect(() => assertNetworkConfig({ ...main, simSinkId: "sim-sink.blindroll.near" })).toThrow("mainnet");
    expect(() => assertNetworkConfig({ ...main, simSinkId: "sim-sink.blindroll-dev.testnet" })).toThrow("mainnet");
  });
  it("refuses a non-test account, the contract or the token as sim sink", () => {
    expect(() => assertNetworkConfig({ ...base, simSinkId: "sim-sink.near" })).toThrow();
    expect(() => assertNetworkConfig({ ...base, simSinkId: base.contractId })).toThrow();
    expect(() => assertNetworkConfig({ ...base, simSinkId: base.tokenId })).toThrow();
  });
});

describe("judge sandbox guard", () => {
  it("allows JUDGE_SANDBOX on test networks and refuses it on mainnet", () => {
    assertNetworkConfig({ network: "testnet", contractId: "blindroll.me.testnet", tokenId: "usdc.me.testnet", judgeSandbox: true });
    assertNetworkConfig({ network: "mainnet", contractId: "blindroll.near", tokenId: "usdc-token.near", judgeSandbox: false });
    expect(() => assertNetworkConfig({ network: "mainnet", contractId: "blindroll.near", tokenId: "usdc-token.near", judgeSandbox: true })).toThrow(ValidationError);
  });
});
