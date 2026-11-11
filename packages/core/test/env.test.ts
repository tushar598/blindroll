import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvError, REQUIRED_ENV, findRepoRoot, loadAndCheckEnv, missingEnv } from "../src/env.js";

const full = (): Record<string, string> => Object.fromEntries(REQUIRED_ENV.map((n) => [n, "x"]));

describe("missingEnv", () => {
  it("returns nothing when all are set", () => {
    expect(missingEnv(full())).toEqual([]);
  });
  it("reports missing, empty, whitespace and placeholder values by name", () => {
    const env: Record<string, string | undefined> = full();
    delete env.NEAR_RPC_URL;
    env.SESSION_SECRET = "";
    env.APP_URL = "   ";
    env.NEAR_AI_API_KEY = "...";
    env.RELAYER_PRIVATE_KEY = "ed25519:...";
    env.BLINDROLL_CONTRACT_ID = "blindroll.<your-account>.testnet";
    expect(missingEnv(env).sort()).toEqual(
      ["APP_URL", "BLINDROLL_CONTRACT_ID", "NEAR_AI_API_KEY", "NEAR_RPC_URL", "RELAYER_PRIVATE_KEY", "SESSION_SECRET"].sort(),
    );
  });
});

describe("loadAndCheckEnv", () => {
  it("finds the repo root from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "blindroll-env-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "");
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it("loads the root file and the error carries names, never values", () => {
    const root = mkdtempSync(join(tmpdir(), "blindroll-env-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "");
    writeFileSync(join(root, ".env.local"), "BR_TEST_SET=super-secret-value\nBR_TEST_EMPTY=\n");
    try {
      loadAndCheckEnv({ startDir: root, required: ["BR_TEST_SET", "BR_TEST_EMPTY", "BR_TEST_ABSENT"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const e = err as EnvError;
      expect(e.missing).toEqual(["BR_TEST_EMPTY", "BR_TEST_ABSENT"]);
      expect(e.message).not.toContain("super-secret-value");
    }
    expect(process.env.BR_TEST_SET).toBe("super-secret-value");
    expect(() => loadAndCheckEnv({ startDir: root, required: ["BR_TEST_SET"] })).not.toThrow();
  });

  it("reports a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "blindroll-env-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "");
    try {
      loadAndCheckEnv({ startDir: root, required: ["BR_TEST_NEVER_SET"] });
      expect.unreachable();
    } catch (err) {
      expect((err as EnvError).load.fileFound).toBe(false);
    }
  });
});
