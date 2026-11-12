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
8. NEAR claim: gas-free through the relayer with `claim_near_relayed` (pays only the leaf's own account; built 2026-11-12 after the NEP-366 spike, see [07](07-wallet-verification-and-claims.md)); `claim_near` from the recipient's wallet for any other receiver.
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

Before the app is deployed for judges or users, every on-chain step must happen in a browser wallet, with no terminal. Status (2026-11-12): **all code is done; items 1 and 5 still need the owner's browser.**

1. **Approver #2 in a browser wallet.** *Code done; waiting for the owner's account.* The default approvers are now `tushar1962005.testnet` and `tushar-approver2.testnet` (both Meteor accounts); the optional env `DEMO_ORG_APPROVERS` replaces them. Threshold stays 2. It applies to runs finalized afterwards; a run already on-chain keeps the approvers stored in the contract, and the run page shows those. `tushar-approver2.testnet` must exist before a run is created with it.
2. **"Fund run" button.** *Done.* Sends `ft_transfer_call` (msg `{"fund_run":"<run_key>"}`) from the signed-in approver's wallet and shows that wallet's USDC balance (read by the browser from a public RPC).
3. **"Get test USDC" button (testnet only).** *Done.* Mints the missing amount of mUSDC to the signed-in wallet. Not rendered when the run's network is `mainnet`; the server's `assertNetworkConfig` still runs at startup.
4. **No CLI commands in the UI.** *Done (2026-11-12): deleted.* The copyable NEAR CLI commands are gone from the code, in development too.
5. **More wallets.** *Built (2026-11-12), on by default, untested in a browser except Meteor.* Meteor (Tested), Intear, Sender, Nightly and MyNearWallet (Untested) load through Wallet Selector 10.1.4; `NEAR_WALLETS` only narrows the list. Picker modal with icons and Tested/Untested badges. Server-side NEP-413 accepts every format these wallets use, including MyNearWallet's signed `callbackUrl`. Left out, with reasons: HOT, HERE, OKX, Bitget, Ledger, WalletConnect, NEAR Mobile (table in [07](07-wallet-verification-and-claims.md#near-wallets-2026-11-12)).
6. **Refund account in a browser wallet.** *Done (2026-11-12).* Default `tushar1962005.testnet`; the optional env `DEMO_ORG_REFUND_ACCOUNT` replaces it. It is stored in the contract at `create_run`, so it applies to runs created afterwards.
7. **"Reclaim unclaimed funds" button.** *Done (2026-11-12).* On the run page: `reclaim_unclaimed` from the approver's wallet, disabled until the claim deadline has passed, showing the amount and the refund account read from the contract.
8. **"Cancel run" button.** *Done (2026-11-12).* `cancel_run` from an approver's wallet, shown only while the run is Draft or Approved and holds no funds.
9. **Short claim window, test networks only.** *Done (2026-11-12).* At finalize, the claim window can be given in minutes (10 to 180) instead of days, so reclaim can be tried without waiting. The server refuses minutes when `NEAR_NETWORK=mainnet`, and the page does not offer them there. The deadline is real: after it, claims are refused by the contract.
10. [02-user-flows.md](02-user-flows.md) and `HANDOFF.md`: *updated 2026-11-12.*

### Operator-only actions (no UI, on purpose)

`set_paused(paused)` and `set_relayer(relayer)` can only be called by the contract owner, the account that deployed it (`blindroll-dev.testnet` on testnet). They are emergency and maintenance actions of whoever operates the deployment: pause all claims and funding, or replace a compromised relayer. They are not part of any approver or recipient flow, so the app has no button for them; the operator sends them with the deployer's key. Deploying the contract and the app is operator work in the same sense.

One Meteor connection is remembered per browser for this site. Wallet-sent transactions first check that the wallet is connected as the expected signer and ask to reconnect if it is not, so two approvers (or an approver and a recipient) can share a browser by switching accounts.

## Later (stretch, not needed for the hackathon)

- **Move from Wallet Selector to NEAR Connect.** Wallet Selector is deprecated upstream (repo archived 2026-11-10); NEAR's docs recommend NEAR Connect (`@hot-labs/near-connect`, 0.12.0). It covers more testnet wallets (Meteor, Intear, Nightly, Ledger, WalletConnect, Unity, NEAR CLI per its manifest) and has zero npm dependencies. **Trust concern to resolve first:** NEAR Connect downloads each wallet's executor code at runtime from the URL in its manifest (raw.githubusercontent.com or the wallet's own domain) and runs it in a sandboxed iframe that sees every sign request (view messages hold the run key and the address; transactions hold the claim). That is third-party code fetched at page load, outside our lockfile and build. Options: pin a manifest copy with reviewed executor URLs and hashes (subresource integrity), self-host the executors, or accept it per wallet. Work: rewrite `apps/web/lib/client/wallet.ts` (connect, NEP-413 `signMessage`, `signAndSendTransaction`) and re-test every Meteor flow.
- **DAO / multisig approvals.** A real DAO would approve and fund from a multisig or DAO treasury account (e.g. SputnikDAO, Trezu) instead of personal wallets: approvals become DAO proposals, and funding comes from the treasury. The contract already accepts any NEAR account as an approver, so this is mainly UI and proposal-flow work.

## Definition of done

- All tests pass; no secrets committed.
- A judge can follow the README in under 5 minutes and see a real testnet transaction.
- Everything simulated is labelled in the UI, API and README.
- Privacy claims match [08-privacy-model.md](08-privacy-model.md) wording.
