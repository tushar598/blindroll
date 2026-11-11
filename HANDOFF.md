# HANDOFF — read this first in every new session

Last updated: 2026-11-10 (end of day). Update this file at the end of every work session.

## 1. Project in one paragraph
Blindroll is claim-based payroll on NEAR for the NEAR Hackathon (tracks: Real-World Money + Privacy & Private AI). An approver uploads a messy payroll CSV; NEAR AI Cloud (TEE) proposes a column mapping; deterministic code normalizes and runs rules; an attested report is built; approvers sign and fund USDC into a contract that stores only a Merkle root and the report hash; each recipient verifies their wallet, sees only their own row, and claims in their chosen asset/chain (NEAR USDC or 1Click), gas-free. Full specs: `docs/` (start at `docs/README.md`). Rules: `AGENTS.md`.

Deadline: hackathon ends Nov 14, 2026 (confirm the exact time on https://nearhackathon.com). Plan: `docs/12-build-plan.md`.

## 2. Current state (git: 3 local commits, nothing pushed)
| Commit | What |
|---|---|
| `69af86f` | Monorepo scaffold (pnpm; apps/web = Next.js 16 App Router; packages/core; contracts/blindroll; contracts/mock-usdc), Merkle + claim message logic with shared test vectors, Blindroll contract, mock USDC |
| `5a4fb7c` | `reopen_claim` uses the amount stored per claimed leaf (no amount argument); sandbox tests for failed payout, reopen, pause, reclaim |
| `4a7cd11` | CSV parse, mapping validation, normalization, rules R001–R006 and R009–R011; `scripts/deploy-testnet.sh` (written, **not run**) |

Tests at last check: `pnpm -r test` 110 passed; `cd contracts && cargo test` 97 Blindroll unit + 5 mock-usdc unit + 2 sandbox passed; clippy clean.

Nothing in the product is simulated yet.

### Implemented beyond the original spec (all documented in docs/04 / docs/07)
- Claims store `{ amount, oneclick, settled }` per leaf; `reopen_claim(run_key, leaf_hash_hex)` releases the stored amount, refuses while a payout is in flight, and refuses `near_ft` payouts.
- `create_run` charges the creator 0.00225 NEAR per recipient for claim costs.
- `storage_deposit` (registration_only) + `ft_transfer` in one receipt (atomic).
- `reclaimed_amount` on Run; reclaim can be retried; works on partly funded runs after the deadline.
- `quote_ref` dropped (the 1Click deposit address is the signed payout target).
- `claim_evm` takes `destination_asset` and `destination_address` to rebuild the `to:` line.
- Input validation: `run_key` = `[A-Za-z0-9_-]{1,64}`; no `|`, `\n`, `\r` in any leaf/message field; proofs ≤ 32 items.
- Mock USDC refuses to init/mint unless its account ends in `.testnet`, `.test.near` or `.sandbox`; `assertNetworkConfig` in `packages/core/src/config.ts` must be called by the app and scripts.
- CSV: no currency column → treated as USDC (must be noted in the report); misplaced thousands separator → invalid amount; unknown chain value → R011. R007/R008 are on the cut list.

## 3. Decisions made by the owner (not yet acted on — do these next)
1. **Model:** use `z-ai/glm-5.3-flash` (the live API rejects `zai-org/GLM-5.1-FP8` with `x-no-aliasing: true`). Update `docs/05`, `docs/10`, `.env.example`.
2. **Testnet deploy: approved.** Run `PARENT=blindroll-dev.testnet RELAYER=relayer.blindroll-dev.testnet ./scripts/deploy-testnet.sh` and report transaction links. The owner approves keychain prompts.
3. **Approvers:** #1 `tushar1962005.testnet` (Meteor wallet, browser; has 5 NEAR). #2 `blindroll-dev.testnet` (CLI). Threshold 2.
4. **Keep both `reopen_claim` guards.**
5. **"Proving the refund"** (balance vs liabilities check in `reopen_claim`): don't build now. Revisit Nov 13 only if the MVP works end to end; otherwise list it in the README as a known limitation.
6. **CSV behaviours approved.** Add "currency defaulted to USDC" to the report when there's no currency column.

## 4. Accounts and environment
| Item | Value |
|---|---|
| Dev/parent account | `blindroll-dev.testnet` (faucet-funded, ~7.99 NEAR; key in the macOS keychain via NEAR CLI) |
| Contract | `blindroll.blindroll-dev.testnet` (to be created by the deploy script) |
| Mock USDC | `usdc.blindroll-dev.testnet` (to be created by the deploy script) |
| Relayer | `relayer.blindroll-dev.testnet` |
| Approver #1 | `tushar1962005.testnet` (Meteor web wallet) |
| Approver #2 | `blindroll-dev.testnet` |
| Tooling | cargo-near 0.23, NEAR CLI 0.31.1 (in `~/.cargo/bin`), Node 24, pnpm, Rust 1.96 (no pin needed) |

**Env file:** all variables from `.env.example` are filled in **one file at the repo root: `near_bulid/.env.local`** (git-ignored, confirmed). It is NOT inside `apps/web`. Make both the Next.js app and `scripts/` load this root file (e.g. `@next/env` `loadEnvConfig` pointed at the repo root). Never print, log or commit values.

`NEAR_AI_API_KEY` is the $10 NEAR Builders key. First confirm both the completion and the signature fetch work with it.

## 5. Next steps, in order
1. Env loading for app + scripts from the root `.env.local`.
2. Apply decision 1 (model) and the docs updates.
3. Testnet deploy → send transaction links (NearBlocks).
4. NEAR AI Cloud: preflight attestation, one mapping call (header + 5 masked rows of `docs/samples/payroll-messy.csv`), signature fetch, save fixtures under `packages/core/test-vectors/ai/`, then build the client and verifier against them. Follow the credit rules in `docs/05`.
5. Nov 12 plan (`docs/12`): report builder, finalize, approver UI (upload → review → finalize → create/approve/fund), report verify page, claim page (EVM view + options board with 1Click dry quotes).
6. Nov 13: claim submit via relayer (EVM + NEAR), payout status, refund → reopen path, export, deploy the app.
7. Nov 14: README (do X → see Y, real vs simulated), 2-minute video, submit.

## 6. Open risks / known gaps
- `reopen_claim` trusts that 1Click really refunded (see docs/04 "Open issue: proving the refund").
- 1Click has no testnet: on testnet, cross-chain delivery will need a SIMULATION REQUEST to the owner before building it (dry quotes are real).
- 1Click quote response schema not yet confirmed with a real call.
- Native mainnet USDC contract ID and its `storage_deposit` behaviour not yet confirmed.
- Wallet support for signing NEP-366 delegate actions not yet checked (fallback: direct `claim_near` call).
- Confidential Intents: optional, timeboxed to one day, not started.

## 7. How to work with the owner
- Ask before simulating anything: send a **SIMULATION REQUEST** (what, why, where, labelling, what stays real, path to real).
- Report problems as **BLOCKER** (what tried, what happened, cause, options).
- Ask for things as **HELP NEEDED** (what, why, where to get it, where to put it, what happens next). Never ask for keys in chat.
- After each milestone send **PROGRESS** (done, tests, real vs simulated, next, need from you).
- Update this file before ending a session.
