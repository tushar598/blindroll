# Blindroll

Claim-based payroll on NEAR for DAOs and crypto-native teams (NEAR Hackathon: Real-World Money + Privacy & Private AI).

An approver uploads a payroll CSV. NEAR AI Cloud proposes which column is which; code normalizes the table and runs the rule checks. Approvers lock test USDC in a contract that stores only a Merkle root and a report hash. Each contributor signs with their own wallet, sees only their own row, and claims their own payout.

- No public salary table. Payroll data is processed privately; only a Merkle root and a report hash go on-chain.
- Each contributor sees only their own row.
- Payouts are standard on-chain transfers: a claim makes that recipient's address and amount public. See [what is and isn't private](#what-is-and-isnt-private).

Specs are in [`docs/`](docs/README.md). Everything below runs on **NEAR testnet** with a mock USDC token.

| | |
|---|---|
| Contract | [`blindroll.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/blindroll.blindroll-dev.testnet) |
| Test token (mUSDC) | [`usdc.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/usdc.blindroll-dev.testnet) |
| Relayer (pays gas for EVM-wallet claims) | [`relayer.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/relayer.blindroll-dev.testnet) |
| Example run on-chain | [`create_run` transaction](https://testnet.nearblocks.io/txns/4Got5u17zqcup7Fk6NDGMtX5TrZbdD5cMU4Xcrqfgixu) |
| Hosted demo | Not deployed yet; run it locally (below) |

## Try it: do X → see Y

You need the [Meteor wallet](https://meteorwallet.app) with a testnet account that is an approver of the demo organization, and MetaMask (or any EVM wallet extension) for an EVM recipient.

| Do | See |
|---|---|
| Open the app, **Sign in with NEAR** (Meteor) | Your approver account in the header. Signing in is a signed message, not a transaction |
| **New run**: upload [`docs/samples/payroll-messy.csv`](docs/samples/payroll-messy.csv) | The proposed column mapping (one NEAR AI Cloud call, or a cached result for a file seen before) and the normalized table with rule findings: errors on bad rows, a warning on an outlier |
| Fix or remove the rows with errors, accept the warning with a reason, **Finalize** | The Merkle root and the report hash. The table is locked |
| **Create run from my wallet** | A real `create_run` transaction. Only the root, the report hash, approvers and deadline are stored |
| **Approve** as each approver (threshold 2) | Approvals appear as each approver signs; the page re-reads the contract by itself |
| **Get test USDC**, then **Fund** | The run becomes Active and shows the claim link |
| Open the claim link, connect the recipient's wallet, sign the view message | Only that wallet's row. A wallet that is not in the run learns nothing |
| Choose **USDC on NEAR** and claim | EVM wallet: you sign a message, the relayer submits it and pays the gas. NEAR wallet: you send `claim_near` yourself. The test USDC arrives and the transaction is linked |
| Choose **USDC on Base** (badged **Simulated**) and claim | A real claim that pays the test USDC to a holding account. Nothing arrives on Base: 1Click has no testnet |
| On the run page, **Claims** → **Simulate a failed delivery and refund** → **Reopen claim** | A real refund transfer back to the contract (linked), then a real `reopen_claim`. The recipient can claim again |
| Open **Verify the report and export** | ✓ / ✗ for each check, computed in your browser: report hash, the hash stored on the contract (read from a public RPC), Merkle root, totals, and the NEAR AI Cloud signature. Approvers can download the reconciled CSV/JSON |

## Run it locally

Requirements: Node 24+, pnpm. For the contracts: Rust 1.95+ with the `wasm32-unknown-unknown` target and [`cargo-near`](https://github.com/near/cargo-near) 0.23+.

```
pnpm install
cp .env.example .env.local     # at the repo root; fill in the values (never commit this file)
pnpm env:check                 # prints only the NAMES of anything missing
pnpm --filter web dev          # http://localhost:3000
```

Tests:

```
pnpm -r test                   # vitest: packages/core and apps/web
pnpm -r typecheck
cd contracts && cargo test     # Rust unit tests + a local sandbox test (builds both wasm files)
```

Read-only checks against testnet: `pnpm report:verify <run_key>` (the verify page's checks from the command line), `pnpm simsink:check`. `pnpm relayer:check` sends one harmless transaction from the relayer.

## How it works

1. **CSV → table.** The file is parsed by code. One NEAR AI Cloud call returns a schema-validated column mapping; emails are masked before the call. The AI never decides a payment: amounts, addresses and all rule checks are computed by code, and an approver can map the columns by hand instead.
2. **Review.** Errors must be fixed or the row removed; warnings need a written reason. Every edit re-runs the whole check.
3. **Finalize.** Each row becomes a salted leaf; the leaves form a Merkle tree. A report (hashes and counts only) is written as canonical JSON and its sha256 goes on-chain with the root.
4. **Approve and fund.** `create_run`, `approve_run` (2 of 2) and an `ft_transfer_call` that funds the run, all signed in the approvers' wallets.
5. **Claim.** The recipient proves the address is theirs with a signature, gets their row and Merkle proof, and claims. The contract checks the proof and the signature, marks the leaf claimed and transfers the USDC.

The leaf format, Merkle rules and claim message are identical in TypeScript (`packages/core`) and Rust (`contracts/blindroll`); shared test vectors prove it byte for byte.

## Real vs simulated

| Part | Status |
|---|---|
| Blindroll contract (Merkle proofs, EVM signature recovery, approvals, payouts, reopen) | **Real**, deployed on NEAR testnet |
| Approver flow: sign-in, create, approve, fund | **Real** testnet transactions from browser wallets |
| AI column mapping | **Real** NEAR AI Cloud call. The response signature is verified at finalize and again on the verify page |
| Claims paid as USDC on NEAR (EVM wallet through the relayer, NEAR wallet directly) | **Real** testnet transactions |
| USDC | **Mock token** (`contracts/mock-usdc`, symbol `mUSDC`, open mint, no value). Real USDC exists only on mainnet, which this project has not used |
| Cross-chain payout estimates (USDC on Base / Arbitrum) | **Real** 1Click dry quotes, priced with mainnet assets and labelled "estimated". A dry quote moves no funds |
| Cross-chain delivery on testnet | **Simulated.** 1Click has no testnet. The recipient really signs, the contract really verifies and really pays the test USDC, but to a holding account (`SIM_SINK_ACCOUNT_ID`) where a 1Click deposit address would be. Nothing arrives on the destination chain. Marked `simulated: true` in API responses and badged "Simulated" on the claim page and the approver's run page |
| Failed delivery → refund → reopen on testnet | The **failure is simulated** (an approver presses a button). The **refund is real**: the holding account transfers the same test USDC back to the contract, and only after that transaction does the app allow the real on-chain `reopen_claim`. The refund transaction is linked in the UI |
| TEE attestation of the AI call | **Stored, not verified.** See limitations |
| EVM signatures in tests | Real secp256k1 signatures made with the public Hardhat/Anvil development keys (test fixtures, not secrets) |

The simulation exists only on test networks: with `NEAR_NETWORK=mainnet` the app refuses to start if a holding account is configured, and never offers a simulated option.

## What is and isn't private

| | Visible to the public? |
|---|---|
| The full payroll table, unclaimed rows | No. Never published |
| Names, emails, roles, memos | No. Off-chain only |
| AI prompts and responses | No. Only their hashes and the signature are in the report |
| Run, approvers, threshold, deadline, total funded, Merkle root, report hash | Yes |
| A claimed row's address and amount | **Yes, once claimed** (claim transaction and token transfer) |

After everyone has claimed, an observer can rebuild most addresses and amounts from the chain. What stays hidden: unclaimed rows, identities, memos, and the table before claims.

The Blindroll backend sees the table in plaintext. It stores it encrypted at rest (AES-256-GCM) and serves each recipient only their own row after a valid signature from that address. Approvers see the table. The model sees the header and sample rows inside NEAR AI Cloud's TEE.

## Known limitations

- **Attestation is not verified.** The TEE attestation is fetched before the AI call, bound to a fresh nonce and stored, and its hash is in the report, but the Intel TDX quote is not verified. Only the response signature is. The report and the verify page say `verified: false`.
- **Refunds are not proven on-chain.** `reopen_claim` trusts the approvers that the funds came back. The app only offers it after the refund transfer succeeded, but the contract itself does not compare its balance with what it owes.
- **NEAR-wallet claims pay their own gas.** EVM-wallet claims are gas-free (the relayer submits them). A NEAR recipient sends `claim_near` from their own wallet.
- **One NEAR wallet.** Only Meteor is wired.
- **Cross-chain delivery is not real on testnet** (above). The mainnet 1Click path with a real quote and deposit address is not built.
- **One seeded organization.** There is no organization management UI; approvers are configuration.
- **A backend you must trust** (above), and a single SQLite file as its database.
- Not built: confidential payouts, Solana wallets, notifications, history-based rules.

## Mock USDC is test-only

`contracts/mock-usdc` lets anyone mint any amount. To stop it being used on mainnet by mistake:

- The contract panics in `new` and `mint` unless its own account ID ends with `.testnet`, `.test.near` or `.sandbox`.
- `assertNetworkConfig` in `packages/core/src/config.ts` refuses `NEAR_NETWORK=mainnet` together with a test-network token or contract ID. The app and deploy scripts must call it at startup.
- On mainnet, set `USDC_TOKEN_ID` to native USDC, after confirming the contract ID from Circle's or NEAR's documentation and checking the `storage_deposit` note in `docs/04-smart-contract-spec.md`.
