# 12 — Build plan

The hackathon runs Nov 1–14, 2026 (per other teams' READMEs; confirm the exact submission deadline and time zone on https://nearhackathon.com). Plan for **submitting by Nov 14 morning**.

## MVP definition (must work for real)

1. Approver signs in with NEAR (testnet).
2. Upload a messy CSV → real NEAR AI Cloud mapping → normalized table with rule findings.
3. Overrides with reasons; finalize → Merkle root + attested report.
4. `create_run`, `approve_run` (2 approvers, threshold 2), fund with mock USDC — all real testnet transactions.
5. Claim page: EVM wallet signs view → sees only own row.
6. Payout options board with **real 1Click dry quotes**.
7. EVM claim: sign → relayer → `claim_evm` → real testnet transfer (`near-usdc` to a NEAR account, or `oneclick` simulated).
8. NEAR claim: `claim_near` (meta-transaction if the wallet supports it, otherwise direct).
9. One failure path shown: a payout marked refunded → `reopen_claim` → claim again.
10. Report verify page: report hash matches the contract; AI signature verifies.
11. Reconciled CSV export.

## Cut list (do not build unless the MVP is done)

- Solana wallets.
- Real mainnet 1Click execution (do one recorded run at most).
- Confidential rail (one-day timebox, separate from the MVP).
- Org management UI (seed orgs and approvers in the DB).
- History-based rules `R007`/`R008` (need past runs; seed one past run if time allows).
- Email/Discord notifications.

## Day-by-day

| Day | Goal | Done when |
|---|---|---|
| **Nov 10** | Monorepo scaffold; `packages/core` merkle + leaf + claim message + test vectors; contract `create_run`/`approve_run`/`ft_on_transfer`/`claim_near`/`claim_evm`/`reclaim_unclaimed` with unit tests; mock USDC | `cargo test` and `vitest` green; vectors match in both languages |
| **Nov 11** | Sandbox integration tests (`near-workspaces`); deploy to testnet; CSV parse + normalize + rules; NEAR AI Cloud mapping with signature fetch | A messy sample CSV becomes a clean table with findings; contract live on testnet |
| **Nov 12** | Approver UI (upload → review → finalize → create/approve/fund); report builder + verify page; claim page (EVM view, options board with dry quotes) | Full approver flow on testnet in the browser |
| **Nov 13** | Claim submit via relayer (EVM + NEAR); payout status; refund → reopen path; export; deploy app (Vercel or similar) | End-to-end demo works on the deployed URL |
| **Nov 14** | README with do X → see Y + real vs simulated table; 2-minute video; final checks; submit | Submitted |

Confidential Intents test: run it in parallel on Nov 11 only if someone has spare time, timeboxed to that day.

## Before the deployed version: replace CLI steps with browser wallets (required)

For now, approver #2 (`blindroll-dev.testnet`) approves and funds through NEAR CLI commands shown on the run page, because that account has no browser wallet. This is **temporary, owner-approved for local testing only**. Before the app is deployed for judges or users, every on-chain step must happen in a browser wallet, with no terminal:

1. **Approver #2 in a browser wallet.** The owner creates a second testnet wallet account (e.g. a second Meteor account) and it replaces `blindroll-dev.testnet` as approver #2 in the seeded org. Threshold stays 2.
2. **"Fund run" button.** Sends `ft_transfer_call` (msg `{"fund_run":"<run_key>"}`) from the connected wallet, and shows that wallet's mUSDC balance.
3. **"Get test USDC" button (testnet only).** Mints mUSDC to the connected wallet. Hidden when `NEAR_NETWORK=mainnet`; `assertNetworkConfig` must pass.
4. **No CLI commands in the UI.** Remove the copyable commands, or show them only when `NODE_ENV=development`, never in a production build.
5. **More wallets.** Add common NEAR wallets from Wallet Selector besides Meteor (check which support testnet and NEP-413 `signMessage`).
6. Update [02-user-flows.md](02-user-flows.md) and `HANDOFF.md` when done.

## Later (stretch, not needed for the hackathon)

- **DAO / multisig approvals.** A real DAO would approve and fund from a multisig or DAO treasury account (e.g. SputnikDAO, Trezu) instead of personal wallets: approvals become DAO proposals, and funding comes from the treasury. The contract already accepts any NEAR account as an approver, so this is mainly UI and proposal-flow work.

## Definition of done

- All tests pass; no secrets committed.
- A judge can follow the README in under 5 minutes and see a real testnet transaction.
- Everything simulated is labelled in the UI, API and README.
- Privacy claims match [08-privacy-model.md](08-privacy-model.md) wording.
