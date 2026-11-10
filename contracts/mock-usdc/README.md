# mock-usdc (TEST ONLY)

Open-mint NEP-141 token with 6 decimals (`mUSDC`), standing in for USDC in the local sandbox and on NEAR testnet. Anyone can call `mint(account_id, amount)`, so the token has no value.

**Never deploy or configure this on mainnet.** Guards:

1. `new` and `mint` panic unless the contract's own account ID ends with `.testnet`, `.test.near` or `.sandbox`.
2. `assertNetworkConfig` (`packages/core/src/config.ts`) rejects a mainnet configuration that points at a test-network token.

On mainnet Blindroll uses native USDC (`USDC_TOKEN_ID`).
