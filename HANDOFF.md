# HANDOFF — read this first in every new session

Last updated: 2026-11-11 (after the report builder, finalize, approver backend and approver UI). Update this file at the end of every work session.

## 1. Project in one paragraph
Blindroll is claim-based payroll on NEAR for the NEAR Hackathon (tracks: Real-World Money + Privacy & Private AI). An approver uploads a messy payroll CSV; NEAR AI Cloud (TEE) proposes a column mapping; deterministic code normalizes and runs rules; an attested report is built; approvers sign and fund USDC into a contract that stores only a Merkle root and the report hash; each recipient verifies their wallet, sees only their own row, and claims in their chosen asset/chain (NEAR USDC or 1Click), gas-free. Full specs: `docs/` (start at `docs/README.md`). Rules: `AGENTS.md`.

Deadline: hackathon ends Nov 14, 2026 (confirm the exact time on https://nearhackathon.com). Plan: `docs/12-build-plan.md`.

## 2. Current state (git: local commits only, nothing pushed)
| Commit | What |
|---|---|
| `69af86f` | Monorepo scaffold (pnpm; apps/web = Next.js 16 App Router; packages/core; contracts/blindroll; contracts/mock-usdc), Merkle + claim message logic with shared test vectors, Blindroll contract, mock USDC |
| `5a4fb7c` | `reopen_claim` uses the amount stored per claimed leaf (no amount argument); sandbox tests for failed payout, reopen, pause, reclaim |
| `4a7cd11` | CSV parse, mapping validation, normalization, rules R001–R006 and R009–R011; `scripts/deploy-testnet.sh` |
| `c66096c` | Root `.env.local` loading + startup check (`@blindroll/core/env`, `pnpm env:check`); model `z-ai/glm-5.3-flash`; HANDOFF.md |
| `483000a` | NEAR AI Cloud fixture, mapping client and signature verifier (`packages/core/src/ai/`) |
| `9a0d833` | Report builder, review and finalize (`packages/core/src/report/`) |
| (latest) | Approver backend (SQLite, NEP-413 sign-in, run API) and approver UI in `apps/web` |

Tests at last check (2026-11-11): `pnpm -r test` 143 (core) + 14 (web) passed; `pnpm -r typecheck`, `pnpm --filter web lint` and `pnpm --filter web build` clean; `cargo test` 97 + 5 unit, 2 sandbox passed (last run inside the deploy script; contracts unchanged since).

Nothing in the product is simulated.

### Approver app (2026-11-11)
- Flow built: sign in (Meteor, NEP-413) → upload CSV → column mapping (cache → live AI when `NEAR_AI_LIVE=1` → manual form) → review table (edit, remove with reason, accept warnings with reason) → finalize → `create_run` / `approve_run` / fund, each from the wallet or with a copyable NEAR CLI command → "Refresh on-chain status".
- **Verified:** the whole API flow over HTTP against the built app with a locally minted session and a throwaway database, including the real RPC `get_run` view call.
- **NOT yet verified (needs the owner's browser + Meteor wallet):** the wallet sign-in, and `create_run` / `approve_run` sent from the wallet. If Meteor signs NEP-413 with a key that is not a full-access key, sign-in returns `key_not_owned`; then relax `isFullAccessKey` in `lib/server/rpc.ts` after checking what key it used.
- Run it: `pnpm --filter web dev`, open http://localhost:3000. `NEAR_AI_LIVE` is `0` in the env file, so a first upload of a file asks for a manual mapping; set `NEAR_AI_LIVE=1` to make one real mapping call per new file (cached by CSV hash afterwards).
- Not built yet: report verify page, claim page, export.

### Testnet deployment (2026-11-11, real)
`blindroll.blindroll-dev.testnet` (owner `blindroll-dev.testnet`, relayer `relayer.blindroll-dev.testnet`, token `usdc.blindroll-dev.testnet`, not paused). 100,000 mUSDC minted to `blindroll-dev.testnet`.
| Step | Tx (https://testnet.nearblocks.io/txns/<id>) |
|---|---|
| create usdc account | `52183BAH6Dbi7DaSJZ7iz3cceqhB5A4driqhaHmLLgKH` |
| create blindroll account | `Dso3sXsYot5cK6rKFmrv37t7jKqqGGbSYxWYF9KGjfZf` |
| deploy + init mock USDC | `DWzeWztdA4VfRDGVGE1vV4ejTrPbrojdLxXF1yEL2bPy` |
| deploy + init Blindroll | `DS8nXkH1KoqeWvQdoNzaEzARAwCQDLKNwyXQ8A2gPtSj` |
| storage_deposit for Blindroll | `8irhLTw5RZ3t8mkR5zSoQUEvedzWzoSfsVZK1t7Uf4NK` |
| mint 100,000 mUSDC | `Focvxuby7K2UbriPpUVAR5zQhoKYmqyWgwQwRccZXwe6` |

### NEAR AI Cloud (2026-11-11, real)
- The $10 Builders key works for the completion and the signature fetch. One live call made so far (899 tokens).
- Fixture in `packages/core/test-vectors/ai/`; client + verifier in `packages/core/src/ai/`; details in docs/05 "What the code does today".
- The real `provider_tee` ECDSA signature verifies. **Intel DCAP quote verification is not done** → reports must say `ai.attestation.verified: false` (docs/05 MVP fallback); list it in the README.
- Re-record only on purpose: `NEAR_AI_LIVE=1 FORCE=1 pnpm ai:record` (changing the prompt or request format breaks the drift test until re-recorded).

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

## 3. Decisions made by the owner
Done: model `z-ai/glm-5.3-flash`; testnet deploy.
Done as well: approvers and threshold (seeded as `DEMO_ORG` in `apps/web/lib/server/config.ts`); "currency defaulted to USDC" report note; attestation fallback agreed (`ai.attestation.verified: false`, raw attestation stored, README limitation; revisit only if the MVP is done with time left).
Still to apply:
1. **Approvers:** #1 `tushar1962005.testnet` (Meteor wallet, browser; has 5 NEAR). #2 `blindroll-dev.testnet` (CLI). Threshold 2. (Seeded; #2 approves and funds with the CLI commands the UI shows.)
2. **Keep both `reopen_claim` guards.**
3. **"Proving the refund"** (balance vs liabilities check in `reopen_claim`): don't build now. Revisit Nov 13 only if the MVP works end to end; otherwise list it in the README as a known limitation.
4. **CSV behaviours approved.** Add "currency defaulted to USDC" to the report when there's no currency column (do it in the report builder).
5. `relayer.blindroll-dev.testnet` already exists (2 NEAR); its key is `RELAYER_PRIVATE_KEY` in the env file. Never add a create step for it.

## 4. Accounts and environment
| Item | Value |
|---|---|
| Dev/parent account | `blindroll-dev.testnet` (faucet-funded, ~2.7 NEAR left after the deploy; key in the macOS keychain via NEAR CLI) |
| Contract | `blindroll.blindroll-dev.testnet` (deployed) |
| Mock USDC | `usdc.blindroll-dev.testnet` (deployed) |
| Relayer | `relayer.blindroll-dev.testnet` |
| Approver #1 | `tushar1962005.testnet` (Meteor web wallet) |
| Approver #2 | `blindroll-dev.testnet` |
| Tooling | cargo-near 0.23, NEAR CLI 0.31.1 (in `~/.cargo/bin`), Node 24, pnpm, Rust 1.96 (no pin needed) |

**Env file:** one file at the repo root, `near_bulid/.env.local` (git-ignored). `packages/core/src/env.ts` loads it for the app (`apps/web/next.config.ts`) and for scripts; `pnpm env:check` prints only the names of missing variables (all 16 set on 2026-11-11). Never print, log or commit values. A Claude Code hook blocks shell commands that name the file, so agents cannot read it; use `.env.example` for names.

Scripts in `scripts/` are `.mts` and run through `tsx` in `packages/core` (see the root `package.json` scripts).

## 5. Next steps, in order
1. Owner tests the approver flow in the browser (see "Approver app" above); fix whatever the wallet shows.
2. Rest of the Nov 12 plan (`docs/12`): report verify page (`/runs/<run_key>/report`: recompute the hash, compare with the contract, re-verify the AI signature), claim page (EVM view + options board with 1Click dry quotes).
3. Nov 13: claim submit via relayer (EVM + NEAR), payout status, refund → reopen path, export, deploy the app. SQLite on a serverless host does not persist: pick a host with a disk, or decide on another database first.
4. Nov 14: README (do X → see Y, real vs simulated, known limitations incl. attestation and "proving the refund"), 2-minute video, submit.

## 6. Open risks / known gaps
- AI attestation: only the signature and the nonce/signer binding fields are checked; no Intel DCAP quote verification (see docs/05).
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
