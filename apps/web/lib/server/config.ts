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
  };
  // Refuses, for example, the mock USDC on mainnet.
  assertNetworkConfig({ network: cfg.network, contractId: cfg.contractId, tokenId: cfg.tokenId });
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
  approvers: ["tushar1962005.testnet", "blindroll-dev.testnet"],
  threshold: 2,
  /** Receives unclaimed funds after the deadline; also the treasury that holds the test USDC. */
  refundAccount: "blindroll-dev.testnet",
} as const;

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
