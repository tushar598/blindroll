# Blindroll

**Claim-based USDC payroll on NEAR: no public salary table, and each contributor sees and claims only their own row.** Built for the NEAR Hackathon (Real-World Money + Privacy & Private AI).

**What makes it different**

1. **Messy CSV in.** Any column names, any number format, straight from the HR or accounting export.
2. **Private AI mapping.** NEAR AI Cloud (a TEE-hosted model) proposes which column is which; the response is **signed**, and the signature is checked. The AI proposes, code decides: it never touches amounts or payment decisions.
3. **Deterministic rules.** Code normalizes amounts to integer base units and runs the checks (bad addresses, duplicates, outliers, budget). Errors block; warnings need a written reason.
4. **Attested report hash locked on-chain.** The report (hashes and counts only, no names or amounts per person) and the Merkle root of the table go into the contract with `create_run`. Anyone can recompute and compare them on the verify page.
5. **Claim-based self-verification.** No public salary table: each recipient connects a wallet, signs a message, sees only their own row and claims it with a Merkle proof.
6. **Gas-free claims via a relayer.** EVM recipients sign a message; NEAR recipients press one button. The relayer pays the gas and cannot redirect the payout.

## Try it in 5 minutes (judges)

Everything runs on NEAR **testnet** with your own wallet: nobody shares keys, and the money is a test token with no value.

1. Open **https://blindroll-production.up.railway.app**
2. Create a free **testnet** account in [Meteor](https://wallet.meteorwallet.app) or [Intear](https://wallet.intear.tech): a named account such as `yourname.testnet` (the 64-character implicit account is refused). If it shows 0 NEAR, get testnet NEAR from the [NEAR faucet](https://docs.near.org/getting-started/faucet) or [near-faucet.io](https://near-faucet.io). **About 0.5 NEAR is plenty.** `create_run` attaches 0.05 NEAR plus 0.00225 NEAR per recipient and refunds what storage does not use (roughly 0.01 NEAR is kept for a two-recipient run); create, approve, "Get test USDC", fund and reclaim each burn well under 0.01 NEAR of gas. Claiming costs the recipient nothing.
3. **Sign in with NEAR** → you get a private sandbox: you are its only approver (1 of 1). Real teams use two or more (the demo org is 2-of-2).
4. Start a run, either way:
   - **Sample CSV:** on the upload screen, "Download the sample CSV" ([`docs/samples/payroll-sandbox.csv`](docs/samples/payroll-sandbox.csv)) and upload it → see the AI column mapping and the rule flags (duplicate, outlier, euro amount, bad address) → remove the bad rows, accept the outlier with a reason → **Finalize**. Its people are fictional, so nobody can claim from it; use it to see the AI and the rules (and the verify page in step 7).
   - **Payees by hand** (to try a claim): "Or add payees by hand" already lists your own account with 10 USDC. Add your MetaMask address as a second payee if you want to try the EVM claim → **Check** → **Finalize**.

   The claim window defaults to 15 minutes in a sandbox, so you can also try **Reclaim** afterwards.
5. **Create run → Approve → Get test USDC → Fund**: four transactions from your wallet.
6. Open the claim link → **Continue as this account** (your NEAR account, same browser) → **Claim (gas-free)** → "Claimed" and a link to the transaction on NEARBlocks. Optional: open the link again with MetaMask and sign the claim message; the relayer pays the gas. Cross-chain delivery is simulated on testnet (labelled on the page).
7. Open **Verify the report and export** on the run page: the report hash against the contract, the AI response signature and each attestation check, one by one.

**Sandbox limits** (per account, per UTC day): 5 runs; 10 rows and 1,000 test USDC per run; 2 live AI mappings (and 40 across all sandboxes; over a limit you map the columns by hand; a file mapped before is reused for free); 5 gas-free claims. Sandbox runs are testnet-only, use the test token, and are isolated per account: you see only your own runs and nobody else sees yours. The full [`payroll-messy.csv`](docs/samples/payroll-messy.csv) totals 14,600.50 USDC, over the sandbox cap: it maps and shows the same flags, but Finalize is refused.

## How a company uses this

- A remote team or a group of contractors is paid once a month.
- Finance exports the run from their HR or accounting tool and uploads the CSV; the AI maps the columns and the rules flag problems before anyone signs.
- Two approvers review and approve the run from their NEAR wallets, then the team funds it with USDC.
- Each contractor opens the claim link, connects a wallet and gets paid in USDC on NEAR (other chains through NEAR Intents 1Click on mainnet; simulated on testnet).
- Finance downloads the reconciled export (claimed, unclaimed, refunded, with transaction hashes); unclaimed funds go back to the treasury after the deadline.

---

## How it works

### Approver flow

![Approver flow](docs/assets/flow-approver.png)

| Step | What happens |
|---|---|
| Sign in | NEAR wallet (Meteor or Intear), signed message, not a transaction |
| Upload CSV | Any column names, any format, up to 500 rows |
| Private AI maps columns | NEAR AI Cloud (TEE-hosted model) returns a signed, schema-validated mapping; only the header and 5 sample rows (emails masked) are sent |
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
| Choose payout | USDC on NEAR (real, pre-selected), or other chains via NEAR Intents 1Click (live mainnet estimates; delivery simulated on testnet) |
| Sign the claim | Locks in the destination; relayer submits on-chain, pays gas |
| Payout delivered | USDC on NEAR (real), or via 1Click cross-chain (simulated on testnet) |
| If delivery fails | Refund returns to contract → approver reopens → recipient claims again |
| Deadline passes | Unclaimed funds returned to treasury via `reclaim_unclaimed` |
| Verify & export | Report hash, Merkle root, AI signature and each attestation check, shown one by one in the browser; CSV/JSON download |

---

## Privacy model

**First, the trust assumption: the Blindroll server can read the full payroll table.** It parses the CSV, stores the table encrypted at rest (AES-256-GCM), and shows a recipient only their own row after a valid wallet signature. On-chain, only the Merkle root and the report hash are public; a claim reveals that one recipient's address and amount. Future work: run the backend in a TEE. The claim page and the run page show this notice.

| | Who can see it |
|---|---|
| Full payroll table | **The Blindroll server and the approvers.** Never published |
| Names, emails, roles, memos | The server and the approvers; off-chain only |
| A recipient's own row | That recipient, after a wallet signature |
| AI prompt (header + 5 sample rows, emails masked) and response | NEAR AI Cloud's model TEE; only their hashes and the response signature are in the report |
| Run metadata (approvers, deadline, total, Merkle root, report hash) | **Public** (contract state) |
| A claimed row's address and amount | **Public, once claimed** (claim transaction) |

After everyone claims, an observer can reconstruct most amounts and addresses from the chain. What stays off the public chain: identities, memos, and rows not yet claimed. Why rows are not encrypted to each recipient's wallet, and what would change that: [docs/08](docs/08-privacy-model.md#why-not-client-side-decryption-yet).

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

## Supported wallets

| Wallet | Used for | Status |
|---|---|---|
| Meteor (NEAR) | Approvers and NEAR recipients | **Tested** on testnet |
| Intear (NEAR) | Approvers and NEAR recipients | **Tested** on testnet (web wallet; if the browser blocks the signing popup, the page asks for one more click) |
| Sender, Nightly, MyNearWallet (NEAR) | — | **Removed** after browser tests: Sender's import failed on Sender's side; Nightly connects the implicit account, not the named one; MyNearWallet did not work reliably in the owner's test |
| MetaMask or any EIP-6963 browser wallet (EVM) | EVM recipients (view + claim signature) | **Tested** with MetaMask |

Left out, with reasons (no testnet, no message signing, or a relay service that would receive our requests): HOT, HERE, OKX, Bitget, Ledger, WalletConnect, NEAR Mobile ([docs/07](docs/07-wallet-verification-and-claims.md#near-wallets-2026-11-12)). Wallet Selector is deprecated upstream; migration to NEAR Connect is planned.

---

## Real vs simulated

| Part | Status |
|---|---|
| NEAR contract: Merkle proofs, EVM signature recovery, approvals, payouts, reopen, reclaim | **Real** (testnet) |
| Approver flow: sign in, create, approve, fund, cancel, reclaim | **Real** testnet transactions from the browser wallet |
| Judge sandbox (`JUDGE_SANDBOX=1`): any testnet account gets a private 1-of-1 org | **Real** testnet transactions; a demo device with lower limits, refused on mainnet |
| AI column mapping | **Real** NEAR AI Cloud call (one per new CSV, cached by its hash) |
| USDC claims via relayer (EVM message signature; NEAR gas-free button) | **Real** testnet transactions |
| USDC | **Mock** (`mUSDC`, open mint, no value; mainnet uses native USDC) |
| Cross-chain payout estimates | **Real** 1Click dry quotes (mainnet prices; labelled "Estimated from live mainnet quote") |
| Cross-chain delivery on testnet | **Simulated**: 1Click has no testnet. The contract really pays the test USDC to a holding account; nothing arrives on the destination chain |
| Failed delivery → refund → reopen | Failure **simulated** by an approver button; the refund transfer and `reopen_claim` are **real** transactions |
| AI check a: response signature | **Verified** (EIP-191 signer = signing address), at finalize and in the browser |
| AI check b: attestation document matches the report hash | **Verified** in the browser |
| AI check c: signer is the attested model key | **Verified** in the browser |
| AI check d: TDX quote binds the signer and our nonce | **Verified** in the browser (consistency only until check g) |
| AI check e: event log replays to RTMR3 | **Verified** in the browser (consistency only until check g) |
| AI check f: MRCONFIGID matches the compose hash | **Verified** in the browser (consistency only until check g) |
| AI check g: Intel TDX quote signature (DCAP) | **Not verified** (no DCAP verifier in this version); report says `ai.attestation.verified: false` |
| AI check h: NVIDIA GPU evidence | **Not verified** (out of scope) |
| Confidential payout rail (Confidential Intents) | **Not built** (roadmap; see Future work) |

Details of every attestation check: [docs/05](docs/05-ai-pipeline-and-attestation.md#attestation-checks-2026-11-12).

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

Use [`docs/samples/payroll-messy.csv`](docs/samples/payroll-messy.csv) as the sample upload. Set `NEAR_AI_LIVE=1` to make a real AI call (cached by CSV hash after the first). Set `JUDGE_SANDBOX=1` (test networks only) to let any account sign in to its own 1-of-1 sandbox.

### For automated reviewers

These need no secrets, no env file and no live AI call:

| Command | What it proves |
|---|---|
| `pnpm install` | The lockfile resolves (`--frozen-lockfile` on the host) |
| `pnpm -r typecheck` | `packages/core` and `apps/web` type-check under `strict` |
| `pnpm -r test` | core: Merkle leaves, proofs and claim messages against the shared test vectors, CSV parsing and rules, the recorded NEAR AI response and its signature, the attestation checks, the report. web: NEP-413 sign-in, the run flow with the recorded AI fixture, claims with real EVM/NEAR signatures against stubbed RPC and relayer, export, and the judge sandbox (isolation and every limit). No network |
| `cd contracts && cargo test` | Contract unit tests (proofs, EVM signature recovery, approvals, funding, payouts, reopen, reclaim, pause) and the sandbox integration test (the wasm on a local `near-sandbox` with the mock token). Needs Rust, the `wasm32-unknown-unknown` target and `cargo-near`; the first run downloads the sandbox binary |

`pnpm build` and `pnpm --filter web dev` need the 16 variables of `.env.example` (they refuse to start without them).

### Demo script for judges (2 minutes)

1. Landing page → **Sign in with NEAR** (any testnet account; a sandbox is created).
2. Upload `payroll-sandbox.csv` → the AI mapping card (model, signature verified) → four rule flags → remove three rows, accept the outlier → Finalize.
3. A second run from "Or add payees by hand" (you + MetaMask) → Finalize → Create → Approve → Get test USDC → Fund.
4. Claim link → Continue as this account → Claim (gas-free) → NEARBlocks; then MetaMask → sign → claimed by the relayer.
5. Verify page: report hash = contract, Merkle root, AI checks a–h with g and h marked "not verified".
6. After 15 minutes: **Reclaim unclaimed funds** on the run page.

The longer script with expected results is in [docs/13](docs/13-testing-and-demo.md#demo-script-2-minutes).

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

- **The backend sees the plaintext table** (encrypted at rest). See the privacy model above.
- **TEE attestation only partly verified.** The response signature and five offline consistency checks pass; the Intel TDX quote signature (DCAP) and the NVIDIA GPU evidence are not verified, so the report says `verified: false`.
- **Refunds not proven on-chain.** `reopen_claim` is offered only after the refund transfer succeeds, but the contract itself does not verify the amount came back.
- **Gas-free NEAR claims pay your own account only.** A different NEAR destination requires sending `claim_near` from your own wallet.
- **Two NEAR wallets.** Meteor and Intear are tested; Sender, Nightly and MyNearWallet were removed after browser tests (see Supported wallets).
- **Cross-chain delivery not real on testnet.** The mainnet 1Click execution path is not built.
- **No org management UI.** Approvers are set via environment config. The judge sandbox creates one 1-of-1 org per account, for demos on testnet only.

## Future work

- **Run the backend in a TEE** (NEAR AI Cloud or a Phala-style confidential VM) and publish its attestation, so the plaintext table is only seen by attested code.
- **Full attestation verification:** an offline Intel DCAP verifier (e.g. `dcap-qvl`) with Intel collateral, a pinned measurement allowlist, and NVIDIA GPU evidence.
- **Confidential payout rail.** Today a claim transaction reveals that one recipient's amount and destination. Settling the payout through NEAR Intents' confidential mode (`CONFIDENTIAL_INTENTS` in the 1Click API) would reduce what a claim reveals; shield/unshield and timing stay public. Needs access from the NEAR Intents team, mainnet testing (no testnet), and a contract hook that pays into the intents contract instead of `ft_transfer`. Details: [docs/06](docs/06-payout-rails.md#roadmap-confidential-payout-rail).
- **Mainnet 1Click execution** (non-dry quote, deposit submit, status polling, refunds from 1Click).
- **Prove refunds in `reopen_claim`** (balance vs liabilities check).

---

## License

MIT — see [LICENSE](LICENSE).
