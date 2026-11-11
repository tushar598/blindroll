/** docs/06. A rail delivers a claimed payout; the contract always pays USDC to one NEAR account. */
export type RailId = "near-usdc" | "oneclick" | "confidential";

export interface PayoutOption {
  /** Stable ID used by the API, e.g. "near-usdc" or "oneclick:base:USDC". */
  id: string;
  rail: RailId;
  /** "USDC on Base" */
  label: string;
  /** 1Click assetId, or "nep141:<usdc token>" for near-usdc. */
  destinationAsset: string;
  /** "near" | "base" | "arb" | … (1Click blockchain names). */
  destinationChain: string;
  symbol: string;
  decimals: number;
  /** Base units of the destination asset. For 1Click this is an ESTIMATE from a dry quote. */
  estimatedAmountOut: string;
  /** Lower bound after slippage, from the dry quote (1Click only). */
  estimatedMinAmountOut?: string;
  /** Only when origin and destination have the same decimals and are both USD stablecoins. */
  feeBps?: number;
  etaSeconds?: number;
  /** True when amounts are estimates rather than the exact amount delivered. */
  estimated: boolean;
  /** True when choosing this option would NOT really deliver the asset in this deployment. */
  simulated: boolean;
  /** False when the option can be shown but not chosen yet (with the reason). */
  available: boolean;
  unavailableReason?: string;
}
