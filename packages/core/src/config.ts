import { ValidationError, isNearAccountId } from "./validate.ts";

export const NETWORKS = ["testnet", "mainnet", "sandbox"] as const;
export type Network = (typeof NETWORKS)[number];

/** Account ID suffixes that only exist on test networks (same list as contracts/mock-usdc). */
export const TEST_NETWORK_SUFFIXES = [".testnet", ".test.near", ".sandbox"] as const;

export function isTestNetworkAccount(accountId: string): boolean {
  return TEST_NETWORK_SUFFIXES.some((s) => accountId.endsWith(s));
}

/**
 * Guards against pointing a mainnet deployment at test accounts, in particular the open-mint
 * mock USDC. Call it once at startup and in every deploy script.
 */
export function assertNetworkConfig(cfg: { network: string; contractId: string; tokenId: string }): void {
  if (!(NETWORKS as readonly string[]).includes(cfg.network)) {
    throw new ValidationError("NEAR_NETWORK must be testnet, mainnet or sandbox");
  }
  if (!isNearAccountId(cfg.contractId)) throw new ValidationError("BLINDROLL_CONTRACT_ID is not a valid NEAR account ID");
  if (!isNearAccountId(cfg.tokenId)) throw new ValidationError("USDC_TOKEN_ID is not a valid NEAR account ID");
  if (cfg.network === "mainnet") {
    if (isTestNetworkAccount(cfg.tokenId)) {
      throw new ValidationError("USDC_TOKEN_ID is a test-network account: the mock USDC must never be used on mainnet");
    }
    if (isTestNetworkAccount(cfg.contractId)) {
      throw new ValidationError("BLINDROLL_CONTRACT_ID is a test-network account but NEAR_NETWORK is mainnet");
    }
  }
}
