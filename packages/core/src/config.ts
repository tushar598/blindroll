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
export function assertNetworkConfig(cfg: { network: string; contractId: string; tokenId: string; simSinkId?: string }): void {
  if (!(NETWORKS as readonly string[]).includes(cfg.network)) {
    throw new ValidationError("NEAR_NETWORK must be testnet, mainnet or sandbox");
  }
  if (!isNearAccountId(cfg.contractId)) throw new ValidationError("BLINDROLL_CONTRACT_ID is not a valid NEAR account ID");
  if (!isNearAccountId(cfg.tokenId)) throw new ValidationError("USDC_TOKEN_ID is not a valid NEAR account ID");
  // The sim sink stands in for a 1Click deposit address where 1Click does not exist. It is a
  // simulation device, so it may only be configured on a test network, with a test account.
  if (cfg.simSinkId !== undefined && cfg.simSinkId !== "") {
    if (cfg.network === "mainnet") throw new ValidationError("SIM_SINK_ACCOUNT_ID must not be set when NEAR_NETWORK is mainnet");
    if (!isNearAccountId(cfg.simSinkId) || !isTestNetworkAccount(cfg.simSinkId)) {
      throw new ValidationError("SIM_SINK_ACCOUNT_ID must be a test-network account");
    }
    if (cfg.simSinkId === cfg.contractId || cfg.simSinkId === cfg.tokenId) {
      throw new ValidationError("SIM_SINK_ACCOUNT_ID must differ from the contract and the token");
    }
  }
  if (cfg.network === "mainnet") {
    if (isTestNetworkAccount(cfg.tokenId)) {
      throw new ValidationError("USDC_TOKEN_ID is a test-network account: the mock USDC must never be used on mainnet");
    }
    if (isTestNetworkAccount(cfg.contractId)) {
      throw new ValidationError("BLINDROLL_CONTRACT_ID is a test-network account but NEAR_NETWORK is mainnet");
    }
  }
}
