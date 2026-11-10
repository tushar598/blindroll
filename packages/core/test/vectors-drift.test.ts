import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateClaimVectors, generateMerkleVectors, toJson } from "../scripts/vectors.js";

const read = (name: string) => readFileSync(new URL(`../test-vectors/${name}`, import.meta.url), "utf8");

describe("committed vectors are up to date", () => {
  it("merkle.json", () => {
    expect(read("merkle.json")).toBe(toJson(generateMerkleVectors()));
  });
  it("claim-message.json", async () => {
    expect(read("claim-message.json")).toBe(toJson(await generateClaimVectors()));
  });
});
