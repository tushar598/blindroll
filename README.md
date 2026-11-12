# Blindroll

**Claim-based payroll on NEAR**,  built for the NEAR Hackathon (Real-World Money + Privacy & Private AI).

DAOs and crypto-native teams run payroll from a single NEAR treasury. Approvers upload a CSV, private AI cleans and validates it, an attested report is locked on-chain, and each contributor claims their own payout in the asset and chain they prefer, gas-free, without ever seeing anyone else's data.

> **No public salary table. No wrong-address payments. No trust in the approver. Just math and signatures.**

---

## How it works

### Approver flow

![Approver flow](docs/assets/flow-approver.png)

| Step | What happens |
|---|---|
| Sign in | NEAR wallet (Meteor), signed message — not a transaction |
| Upload CSV | Any column names, any format, up to 500 rows |
| Private AI maps columns | NEAR AI Cloud (TEE) returns a signed, schema-validated mapping |
| Rules check and review | Errors block finalize; warnings need a written reason |
| Finalize | Merkle root + attested report hash locked — table is immutable |
| Create & approve on-chain | `create_run` + `approve_run` (M-of-N) from browser wallets |
| Fund with USDC | `ft_transfer_call` activates the run; claim link is shared |

### Recipient flow

![Recipient flow](docs/assets/flow-recipient.png)

| Step | What happens |
|---|---|
| Open claim link | The link reveals nothing without a valid signature |
| Connect wallet & sign | Sees only their own row and Merkle proof |
| Choose payout | USDC on NEAR, or any chain via NEAR Intents (1Click) with live estimates |
| Sign the claim | Locks in the destination; relayer submits on-chain, pays gas |
| Payout delivered | USDC on NEAR (real), or via 1Click cross-chain |
| If delivery fails | Refund returns to contract → approver reopens → recipient claims again |
| Deadline passes | Unclaimed funds returned to treasury via `reclaim_unclaimed` |
| Verify & export | Report hash, Merkle root, AI signature — all checked in browser; CSV/JSON download |

---

## Privacy model

| | Visible to the public? |
|---|---|
| Full payroll table, unclaimed rows | **No** — never published |
| Names, emails, roles, memos | **No** — off-chain only |
| AI prompts and responses | **No** — only their hashes and the response signature are in the report |
| Run metadata (approvers, deadline, total, Merkle root, report hash) | **Yes** |
| A claimed row's address and amount | **Yes, once claimed** |

The backend stores the table encrypted at rest (AES-256-GCM) and serves each recipient only their own row after a valid wallet signature. After everyone claims, an observer can reconstruct amounts and addresses from the chain — what stays hidden is everything unclaimed: identities, memos, and rows not yet claimed.

---

## Testnet deployment

| | |
|---|---|
| Contract | [`blindroll.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/blindroll.blindroll-dev.testnet) |
| Test token (mUSDC) | [`usdc.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/usdc.blindroll-dev.testnet) |
| Relayer | [`relayer.blindroll-dev.testnet`](https://testnet.nearblocks.io/address/relayer.blindroll-dev.testnet) |
| Example `create_run` | [transaction on NEARBlocks](https://testnet.nearblocks.io/txns/4Got5u17zqcup7Fk6NDGMtX5TrZbdD5cMU4Xcrqfgixu) |
| Example gas-free claim | [transaction on NEARBlocks](https://testnet.nearblocks.io/txns/7cLq3BTUQA3jpPXbYQUQwReqgyvw3coxjjHFow6VPr4w) |

---

## Real vs simulated

| Part | Status |
|---|---|
| NEAR contract — Merkle proofs, EVM signature recovery, approvals, payouts, reopen | **Real** (testnet) |
| Approver flow — sign in, create, approve, fund | **Real** testnet transactions |
| AI column mapping | **Real** NEAR AI Cloud call; response signature verified at finalize and on the verify page |
| USDC claims via relayer (EVM + NEAR wallets) | **Real** testnet transactions |
| USDC | **Mock** (`mUSDC`, open mint, no value; mainnet uses native USDC) |
| Cross-chain payout estimates | **Real** 1Click dry quotes (mainnet prices, labelled "estimated") |
| Cross-chain delivery on testnet | **Simulated** — 1Click has no testnet; funds go to a holding account, nothing arrives on the destination chain |
| Failed delivery → refund → reopen | Failure **simulated** by approver button; refund and `reopen_claim` are **real** on-chain transactions |
| TEE attestation | Stored, **not verified** (Intel TDX quote verification not implemented; report says `verified: false`) |

---

## Run locally

**Requirements:** Node 24+, pnpm 9+. Contracts: Rust 1.95+, `wasm32-unknown-unknown` target, [`cargo-near`](https://github.com/near/cargo-near) 0.23+.

```sh
pnpm install
cp .env.example .env.local   # fill in values — never commit
pnpm env:check               # lists any missing variable names
pnpm --filter web dev        # http://localhost:3000
```

**Tests:**

```sh
pnpm -r test                 # vitest (packages/core + apps/web)
pnpm -r typecheck
cd contracts && cargo test   # Rust unit tests + sandbox integration test
```

Use [`docs/samples/payroll-messy.csv`](docs/samples/payroll-messy.csv) as the sample upload. Set `NEAR_AI_LIVE=1` to make a real AI call (cached by CSV hash after the first).

---

## Repo structure

```
apps/web/          Next.js 16 app — approver UI, claim UI, API routes
packages/core/     Merkle tree, claim messages, CSV rules, AI client (TypeScript)
contracts/
  blindroll/       NEAR smart contract (Rust)
  mock-usdc/       Testnet-only USDC token (Rust)
docs/              Full specs (product, architecture, contract, AI, privacy, API…)
```

---

## Known limitations

- **TEE attestation not verified.** Only the response signature is checked; Intel TDX quote verification is not done.
- **Refunds not proven on-chain.** `reopen_claim` is offered only after the refund transfer succeeds, but the contract itself does not verify the amount came back.
- **Gas-free NEAR claims pay your own account only.** A different NEAR destination requires sending `claim_near` from your own wallet.
- **One tested wallet.** Meteor only; Intear and Sender are wired but untested.
- **Cross-chain delivery not real on testnet.** The mainnet 1Click execution path is not built.
- **No org management UI.** Approvers are set via environment config.

---

## License

MIT — see [LICENSE](LICENSE).
