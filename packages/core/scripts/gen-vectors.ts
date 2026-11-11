import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateClaimVectors, generateMerkleVectors, toJson } from "./vectors.ts";

const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
writeFileSync(`${dir}merkle.json`, toJson(generateMerkleVectors()));
writeFileSync(`${dir}claim-message.json`, toJson(await generateClaimVectors()));
console.log(`wrote ${dir}merkle.json and ${dir}claim-message.json`);
