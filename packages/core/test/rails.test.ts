// Replays recorded 1Click responses (test-vectors/oneclick). No live calls.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type OneClickFetch, buildQuoteRequest, feeBps, fetchQuote, fetchTokens, findToken, parseQuoteResponse, parseTokens } from "../src/index.ts";

const dir = new URL("../test-vectors/oneclick/", import.meta.url);
const tokensText = readFileSync(new URL("tokens.json", dir), "utf8");
const baseQuote = JSON.parse(readFileSync(new URL("quote-dry-base-usdc.json", dir), "utf8"));

describe("1Click token list", () => {
  const tokens = parseTokens(JSON.parse(tokensText));
  it("finds USDC on NEAR, Base and Arbitrum by chain and symbol", () => {
    expect(findToken(tokens, "near", "USDC")).toMatchObject({ decimals: 6, assetId: baseQuote.request.originAsset });
    expect(findToken(tokens, "base", "USDC")?.assetId).toBe(baseQuote.request.destinationAsset);
    expect(findToken(tokens, "arb", "USDC")?.decimals).toBe(6);
    expect(findToken(tokens, "base", "NOPE")).toBeUndefined();
  });
  it("rejects a malformed list", () => {
    expect(() => parseTokens([{ assetId: 1 }])).toThrow();
  });
});

describe("1Click quotes", () => {
  it("builds the documented request body", () => {
    const req = buildQuoteRequest({
      dry: true, originAsset: "nep141:a", destinationAsset: "nep141:b", amount: 1000000000n,
      recipient: "0x8ba1f109551bd432803012645ac136ddd64dba72", refundTo: "near", deadline: new Date("2026-11-11T08:27:54.125Z"),
    });
    expect(req).toEqual({
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: "nep141:a", depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:b", amount: "1000000000", recipient: "0x8ba1f109551bd432803012645ac136ddd64dba72",
      recipientType: "DESTINATION_CHAIN", refundTo: "near", refundType: "ORIGIN_CHAIN", deadline: "2026-11-11T08:27:54.125Z",
    });
    expect(Object.keys(req).sort()).toEqual(Object.keys(baseQuote.request).sort());
    expect(() => buildQuoteRequest({ dry: true, originAsset: "a", destinationAsset: "b", amount: 0n, recipient: "r", refundTo: "near", deadline: new Date() })).toThrow();
  });
  it("parses the recorded dry quote with integer amounts", () => {
    const q = parseQuoteResponse(baseQuote.response);
    expect(q).toEqual({ amountIn: 1000000000n, amountOut: 999805609n, minAmountOut: 994806580n, timeEstimateSeconds: 22 });
    expect(q.depositAddress).toBeUndefined();
    expect(feeBps(q.amountIn, q.amountOut)).toBe(1);
    expect(feeBps(100n, 100n)).toBe(0);
  });
  it("rejects float or missing amounts", () => {
    expect(() => parseQuoteResponse({ quote: { amountIn: "1", amountOut: "0.5", minAmountOut: "1" } })).toThrow();
    expect(() => parseQuoteResponse({ message: "Internal server error" })).toThrow();
  });
  it("sends the JWT as a bearer token and surfaces HTTP errors without the body", async () => {
    let seen: Record<string, string> | undefined;
    const ok: OneClickFetch = async (url, init) => {
      seen = init?.headers;
      return { status: url.endsWith("/tokens") ? 200 : 201, ok: true, text: async () => (url.endsWith("/tokens") ? tokensText : JSON.stringify(baseQuote.response)) };
    };
    const cfg = { baseUrl: "https://1click.example/v0/", jwt: "jwt-secret", fetch: ok };
    expect((await fetchTokens(cfg)).length).toBeGreaterThan(100);
    expect((await fetchQuote(cfg, baseQuote.request)).amountOut).toBe(999805609n);
    expect(seen?.Authorization).toBe("Bearer jwt-secret");
    const bad: OneClickFetch = async () => ({ status: 400, ok: false, text: async () => '{"message":"Internal server error"}' });
    await expect(fetchQuote({ ...cfg, fetch: bad }, baseQuote.request)).rejects.toThrow("HTTP 400");
  });
});
