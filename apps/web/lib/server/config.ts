import { type Network, assertNetworkConfig } from "@blindroll/core";

/** Server configuration from the environment (loaded and checked in next.config.ts). */
export interface ServerConfig {
  network: Network;
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  aiBaseUrl: string;
  aiModel: string;
  aiLive: boolean;
  appUrl: string;
  relayerAccountId: string;
  oneclickBaseUrl: string;
  /** Testnet only: the account that stands in for a 1Click deposit address. Null when not configured. */
  simSinkAccountId: string | null;
  /** JUDGE_SANDBOX=1 (test networks only): a non-approver gets a private 1-of-1 sandbox org at sign-in. */
  judgeSandbox: boolean;
  /** Live AI mapping calls allowed per UTC day across all sandbox accounts (SANDBOX_AI_DAILY_CAP). */
  sandboxAiDailyCap: number;
}

let cached: ServerConfig | undefined;

export function serverConfig(): ServerConfig {
  if (cached) return cached;
  const env = process.env;
  const cfg: ServerConfig = {
    network: env.NEAR_NETWORK as Network,
    rpcUrl: env.NEAR_RPC_URL!,
    contractId: env.BLINDROLL_CONTRACT_ID!,
    tokenId: env.USDC_TOKEN_ID!,
    aiBaseUrl: env.NEAR_AI_BASE_URL!,
    aiModel: env.NEAR_AI_MODEL!,
    aiLive: env.NEAR_AI_LIVE === "1",
    appUrl: env.APP_URL!,
    relayerAccountId: env.RELAYER_ACCOUNT_ID!,
    oneclickBaseUrl: env.ONECLICK_BASE_URL!,
    simSinkAccountId: env.SIM_SINK_ACCOUNT_ID?.trim() || null,
    judgeSandbox: judgeSandboxEnabled(env),
    sandboxAiDailyCap: sandboxAiDailyCap(env),
  };
  // Refuses, for example, the mock USDC on mainnet, and the judge sandbox on mainnet.
  assertNetworkConfig({ network: cfg.network, contractId: cfg.contractId, tokenId: cfg.tokenId, simSinkId: cfg.simSinkAccountId ?? undefined, judgeSandbox: cfg.judgeSandbox });
  cached = cfg;
  return cfg;
}

/**
 * The demo organization (docs/12 cut list: no org management UI, orgs are seeded).
 * Owner decision 2026-11-11: two approvers, threshold 2.
 */
export const DEMO_ORG = {
  id: "demo-org",
  name: "Blindroll Demo DAO",
  /** Defaults; DEMO_ORG_APPROVERS in the env file replaces them (see demoOrgApprovers). */
  approvers: ["tushar1962005.testnet", "tushar-approver2.testnet"],
  threshold: 2,
  /** Default; DEMO_ORG_REFUND_ACCOUNT replaces it (see demoOrgRefundAccount). A browser-wallet account. */
  refundAccount: "tushar1962005.testnet",
} as const;

/**
 * Approvers of the demo org. Optional env DEMO_ORG_APPROVERS (comma-separated NEAR accounts, at
 * least `threshold` of them) replaces the defaults, so approver #2 can become a browser-wallet
 * account without a code change (docs/12 "Before the deployed version"). It applies to runs
 * finalized afterwards: a run already on-chain keeps the approvers stored in the contract.
 */
export function demoOrgApprovers(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.DEMO_ORG_APPROVERS?.trim();
  if (!raw) return [...DEMO_ORG.approvers];
  const list = raw.split(",").map((a) => a.trim()).filter(Boolean);
  if (list.length < DEMO_ORG.threshold || list.length > 10) throw new Error(`DEMO_ORG_APPROVERS must list ${DEMO_ORG.threshold} to 10 accounts`);
  if (new Set(list).size !== list.length) throw new Error("DEMO_ORG_APPROVERS must not repeat an account");
  for (const a of list) {
    if (!/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a)) throw new Error("DEMO_ORG_APPROVERS holds an invalid NEAR account ID");
  }
  return list;
}

/**
 * The account that receives unclaimed funds after the deadline. Optional env DEMO_ORG_REFUND_ACCOUNT
 * replaces the default. It is stored in the contract at `create_run`, so a change applies to runs
 * created afterwards.
 */
export function demoOrgRefundAccount(env: Record<string, string | undefined> = process.env): string {
  const account = env.DEMO_ORG_REFUND_ACCOUNT?.trim() || DEMO_ORG.refundAccount;
  if (!/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(account)) throw new Error("DEMO_ORG_REFUND_ACCOUNT is not a valid NEAR account ID");
  return account;
}

/**
 * Judge sandbox (docs/02 Flow D). With JUDGE_SANDBOX=1 an account that is not a demo-org approver
 * gets its own org at sign-in: it is the only approver (1 of 1) and the refund account. The limits
 * protect what the hosted app pays for (the NEAR AI key and the relayer's NEAR); they apply to
 * sandbox orgs only, never to the demo org.
 */
export const SANDBOX = {
  orgPrefix: "sandbox:",
  runsPerDay: 5,
  maxRows: 10,
  /** 1,000 USDC in base units (6 decimals). */
  maxTotalBaseUnits: 1_000_000_000n,
  aiCallsPerDay: 2,
  defaultAiDailyCap: 40,
  relayedClaimsPerDay: 5,
  /** The relayer refuses sandbox claims below 1 NEAR, in yoctoNEAR. */
  minRelayerYocto: 1_000_000_000_000_000_000_000_000n,
  defaultClaimMinutes: 15,
} as const;

export const sandboxOrgId = (accountId: string) => `${SANDBOX.orgPrefix}${accountId}`;
export const isSandboxOrg = (orgId: string) => orgId.startsWith(SANDBOX.orgPrefix);
/** The one account that owns a sandbox org (the org ID carries it). */
export const sandboxOwner = (orgId: string) => orgId.slice(SANDBOX.orgPrefix.length);

export function judgeSandboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.JUDGE_SANDBOX?.trim() === "1";
}

export function sandboxAiDailyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SANDBOX_AI_DAILY_CAP?.trim();
  if (!raw) return SANDBOX.defaultAiDailyCap;
  if (!/^\d{1,6}$/.test(raw)) throw new Error("SANDBOX_AI_DAILY_CAP must be a whole number from 0 to 999999");
  return Number(raw);
}

/** The sandbox limits as the UI shows them. */
export const SANDBOX_LIMITS_PUBLIC = {
  runsPerDay: SANDBOX.runsPerDay,
  maxRows: SANDBOX.maxRows,
  maxTotalUsdc: Number(SANDBOX.maxTotalBaseUnits / 1_000_000n),
  aiCallsPerDay: SANDBOX.aiCallsPerDay,
  relayedClaimsPerDay: SANDBOX.relayedClaimsPerDay,
  defaultClaimMinutes: SANDBOX.defaultClaimMinutes,
} as const;

/**
 * Shortest and longest claim window. Minutes are offered on test networks only, so the
 * reclaim-after-deadline step can be tried without waiting days (docs/12).
 */
export const CLAIM_WINDOW = { minDays: 1, maxDays: 365, minMinutes: 10, maxMinutes: 180 } as const;

/** NEAR wallets the client knows how to load (apps/web/lib/client/wallet.ts). Meteor is always offered. */
/**
 * NEAR wallets this app can offer: every Wallet Selector module that works on testnet with an
 * in-page NEP-413 signMessage (docs/07 "NEAR wallets"). Meteor is first and the default.
 */
export const KNOWN_NEAR_WALLETS = ["meteor-wallet", "intear-wallet"] as const;

/**
 * Wallets offered in the UI. All known wallets by default. Optional env NEAR_WALLETS
 * (comma-separated IDs from KNOWN_NEAR_WALLETS) only narrows the list; Meteor is always kept.
 */
export function enabledNearWallets(env: Record<string, string | undefined> = process.env): string[] {
  const list = (env.NEAR_WALLETS ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  for (const w of list) {
    if (!(KNOWN_NEAR_WALLETS as readonly string[]).includes(w)) throw new Error(`NEAR_WALLETS holds an unknown wallet ID (allowed: ${KNOWN_NEAR_WALLETS.join(", ")})`);
  }
  if (list.length === 0) return [...KNOWN_NEAR_WALLETS];
  return KNOWN_NEAR_WALLETS.filter((w) => w === "meteor-wallet" || list.includes(w));
}

export const MAX_RUN_ROWS = 500;
export const DEFAULT_CLAIM_DAYS = 14;

/**
 * 1Click only knows mainnet accounts: a quote with a `refundTo` that does not exist there is
 * rejected (HTTP 400). On mainnet `refundTo` is the Blindroll contract. On testnet, DRY quotes
 * (estimates only, nothing moves) use this existing mainnet account as a stand-in.
 */
export const ONECLICK_DRY_REFUND_STAND_IN = "near";

/** Cross-chain destinations offered on the options board: [1Click blockchain, symbol, label]. */
export const ONECLICK_DESTINATIONS = [
  ["base", "USDC", "USDC on Base"],
  ["arb", "USDC", "USDC on Arbitrum"],
] as const;
