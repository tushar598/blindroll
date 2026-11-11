# Blindroll

Claim-based payroll on NEAR for DAOs and crypto-native teams (NEAR Hackathon: Real-World Money + Privacy & Private AI).

Funds for a payroll run are locked in a contract. Each contributor verifies their own wallet and claims their own payout. Only a Merkle root and a report hash go on-chain, so there is no public salary table. Specs: [`docs/`](docs/README.md).

> Status: work in progress. This README will grow into the judge-facing guide (demo link, "do X → see Y").

## What works today (Nov 10 milestone)

- `packages/core`: leaf hashing, Merkle tree and proofs, claim and view message builders, input validation.
- `contracts/blindroll`: `create_run`, `approve_run`, `cancel_run`, `ft_on_transfer`, `claim_near`, `claim_evm`, `reopen_claim`, `reclaim_unclaimed`, views and events.
- `contracts/mock-usdc`: test-only NEP-141 token.
- Shared test vectors (`packages/core/test-vectors/`) prove the TypeScript and Rust implementations agree byte for byte.
- A local sandbox test deploys both contracts and runs create → approve → fund → claim with real cross-contract calls.

Not built yet: the web app (only a blank Next.js scaffold), CSV/AI pipeline, 1Click rail, relayer, testnet deployment.

## Run the tests

Requirements: Node 24+, pnpm, Rust 1.95+ with the `wasm32-unknown-unknown` target, [`cargo-near`](https://github.com/near/cargo-near) 0.23+.

```
pnpm install
pnpm -r test                 # vitest: packages/core (leaf, Merkle, claim message, vectors)
cd contracts && cargo test   # Rust unit tests + sandbox test (builds both wasm files first)
```

Regenerate the shared vectors after changing a format: `pnpm vectors`, then rerun both suites.

## Real vs simulated

| Part | Status |
|---|---|
| Blindroll contract logic (Merkle proofs, EVM signature recovery, payouts) | Real code, tested in unit tests and a local NEAR sandbox. Not deployed to testnet yet |
| USDC | **Mock token** (`contracts/mock-usdc`, symbol `mUSDC`, open mint, no value) on sandbox and testnet. Real USDC only on mainnet, which this project has not used |
| EVM signatures in tests | Real secp256k1 signatures, made with the public Hardhat/Anvil development keys #0 and #1 (test fixtures, not secrets) |

| Testnet deployment, approver flow, AI column mapping, claims paid as USDC on NEAR | **Real** testnet transactions and a real NEAR AI Cloud call with a verified response signature |
| Cross-chain payout estimates (USDC on Base / Arbitrum) | **Real** 1Click dry quotes, priced with mainnet assets and labelled "estimated". A dry quote moves no funds |
| Cross-chain delivery on testnet | **Simulated.** 1Click has no testnet. The recipient really signs, the contract really verifies and really pays the test USDC, but to a holding account (`SIM_SINK_ACCOUNT_ID`) where a 1Click deposit address would be. Nothing arrives on the destination chain. Marked `simulated: true` in API responses and badged "Simulated" on the claim page and the approver's run page |
| Failed delivery → refund → reopen on testnet | The **failure is simulated** (an approver presses a button). The **refund is real**: the holding account transfers the same test USDC back to the contract, and only after that transaction does the app allow the real on-chain `reopen_claim`. The refund transaction is linked in the UI |

The simulation exists only on test networks: with `NEAR_NETWORK=mainnet` the app refuses to start if a holding account is configured, and never offers a simulated option.

## Mock USDC is test-only

`contracts/mock-usdc` lets anyone mint any amount. To stop it being used on mainnet by mistake:

- The contract panics in `new` and `mint` unless its own account ID ends with `.testnet`, `.test.near` or `.sandbox`.
- `assertNetworkConfig` in `packages/core/src/config.ts` refuses `NEAR_NETWORK=mainnet` together with a test-network token or contract ID. The app and deploy scripts must call it at startup.
- On mainnet, set `USDC_TOKEN_ID` to native USDC, after confirming the contract ID from Circle's or NEAR's documentation and checking the `storage_deposit` note in `docs/04-smart-contract-spec.md`.
