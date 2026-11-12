# scripts

Deploy, seed and end-to-end testnet scripts go here (Nov 11 onwards). Every script must call
`assertNetworkConfig` from `@blindroll/core` before sending a transaction, and load env with `loadAndCheckEnv` from `@blindroll/core/env`
(repo-root `.env.local`; `pnpm env:check` runs the check alone and prints only missing names).

- `pnpm relayed:check plan <recipient.testnet> <state.json>` then `pnpm relayed:check claim <state.json>`: real testnet check of the gas-free NEAR claim (`claim_near_relayed`). `plan` prints the NEAR CLI commands for a throwaway run; `claim` sends one relayer transaction and verifies that the recipient was paid and paid no gas.
