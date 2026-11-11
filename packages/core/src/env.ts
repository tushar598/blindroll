/**
 * Environment loading and the startup check, shared by the Next.js app (next.config.ts) and scripts/.
 *
 * One file is the source of truth: `.env.local` at the repo root (git-ignored).
 * This module is Node-only and has no imports from the rest of core, so it is NOT re-exported from
 * index.ts (which also runs in the browser). Import it as `@blindroll/core/env`.
 *
 * It never returns, prints or logs a value: only variable NAMES appear in results and errors.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Every variable in .env.example. All must be present and non-empty. */
export const REQUIRED_ENV = [
  "NEAR_NETWORK",
  "NEAR_RPC_URL",
  "BLINDROLL_CONTRACT_ID",
  "USDC_TOKEN_ID",
  "RELAYER_ACCOUNT_ID",
  "RELAYER_PRIVATE_KEY",
  "NEAR_AI_API_KEY",
  "NEAR_AI_BASE_URL",
  "NEAR_AI_MODEL",
  "NEAR_AI_LIVE",
  "ONECLICK_BASE_URL",
  "ONECLICK_JWT",
  "ONECLICK_MODE",
  "DATA_ENCRYPTION_KEY",
  "SESSION_SECRET",
  "APP_URL",
] as const;
export type EnvName = (typeof REQUIRED_ENV)[number];

export const ENV_FILE = ".env.local";

/** Placeholder values copied from .env.example count as "not filled in". */
const PLACEHOLDERS = new Set(["...", "ed25519:...", "base64-32-bytes"]);

function isUnset(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  return v === "" || PLACEHOLDERS.has(v) || v.includes("<your-account>");
}

/** Names of required variables that are missing, empty or still a placeholder. Never values. */
export function missingEnv(
  env: Record<string, string | undefined> = process.env,
  required: readonly string[] = REQUIRED_ENV,
): string[] {
  return required.filter((name) => isUnset(env[name]));
}

/** Walks up from `startDir` to the directory that holds pnpm-workspace.yaml. */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repo root (pnpm-workspace.yaml) not found above ${startDir}`);
    dir = parent;
  }
}

export interface EnvLoadResult {
  /** Absolute path of the env file that was looked for. */
  file: string;
  /** False when the file does not exist (e.g. on a host that injects variables itself). */
  fileFound: boolean;
}

/**
 * Loads the repo-root .env.local into process.env. Variables already set in the real environment
 * win over the file (same precedence as Next.js). A missing file is not an error here; the
 * check below reports what is missing.
 */
export function loadRootEnv(startDir: string = process.cwd()): EnvLoadResult {
  const file = join(findRepoRoot(startDir), ENV_FILE);
  const fileFound = existsSync(file);
  if (fileFound) process.loadEnvFile(file);
  return { file, fileFound };
}

export class EnvError extends Error {
  readonly missing: string[];
  readonly load: EnvLoadResult;
  constructor(missing: string[], load: EnvLoadResult) {
    super(
      `Missing or empty environment variables: ${missing.join(", ")}. ` +
        (load.fileFound ? `Fill them in ${load.file}.` : `Env file not found: ${load.file} (copy .env.example there).`),
    );
    this.name = "EnvError";
    this.missing = missing;
    this.load = load;
  }
}

/**
 * The startup check: load the root env file, then fail with the NAMES of anything missing.
 * Call once at startup in the app and at the top of every script.
 */
export function loadAndCheckEnv(
  opts: { startDir?: string; required?: readonly string[] } = {},
): EnvLoadResult {
  const load = loadRootEnv(opts.startDir);
  const missing = missingEnv(process.env, opts.required ?? REQUIRED_ENV);
  if (missing.length > 0) throw new EnvError(missing, load);
  return load;
}
