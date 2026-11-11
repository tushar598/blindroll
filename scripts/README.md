# scripts

Deploy, seed and end-to-end testnet scripts go here (Nov 11 onwards). Every script must call
`assertNetworkConfig` from `@blindroll/core` before sending a transaction, and load env with `loadAndCheckEnv` from `@blindroll/core/env`
(repo-root `.env.local`; `pnpm env:check` runs the check alone and prints only missing names).
