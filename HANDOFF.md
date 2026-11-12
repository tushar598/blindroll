# HANDOFF — read this first in every new session

Last updated: 2026-11-12 (review-fixes session, after the owner's full browser test passed). All work is committed locally (nothing pushed); see "Review fixes (2026-11-12)" below. vitest 163 + 45, typecheck, lint and `pnpm build` pass; `cargo test` 132 + 5 unit tests and 3 sandbox tests pass. Update this file at the end of every work session.

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
| `73c1aea`, `7800b53`, `4936950` | Approver backend + UI; Meteor connect fix; on-chain status auto-refresh |
| `latest` | Claim page and claim flow; 1Click client + fixtures; relayer |
| `ui-overhaul` | Complete brutalist UI overhaul matching Near_build-UI-design: `#E9E1CD` parchment background, `#E1D7C0]/60` cards, all buttons with `#0667DC` cobalt blue background, white text (`text-white font-mono`), white border & white drop-shadow with hover lift (`hover:bg-[#0556B8] hover:shadow-[3px_3px_0px_0px_#ffffff]`), `#322E25]/15` borders, dual-row marquee, responsive layouts |

Tests at last check (2026-11-12): `pnpm -r test` 153 (core) + 43 (web) passed; `pnpm --filter web lint` clean; `pnpm -r typecheck` and `pnpm build` clean; `cargo test` 112 + 5 unit tests and 3 sandbox tests passed.

### Review fixes (2026-11-12, goal: lift the external 6.8/10 review)
Commits `8de2574`..HEAD. No contract code changed, no redeploy, no new dependency, no new external service, no new simulation, no live AI call.
- **Trust notice** (`apps/web/app/components/notices.tsx` → `TrustNotice`) on the claim page and the run page: the server can read the full table (encrypted at rest), shows a recipient only their row after a wallet signature; on-chain only the root and report hash; a claim reveals that one recipient's address and amount; future work: TEE backend. README privacy section and docs/08 now start with this. docs/08 has "Why not client-side decryption (yet)".
- **Attestation checks, one by one** (`packages/core/src/ai/attestation.ts` → `checkAttestationEvidence`; new public `GET /api/runs/:runKey/attestation`, raw stored attestation whose sha256 is in the report). Verify page and `pnpm report:verify` list: (a) response signature ✅, (b) document hash = report ✅, (c) signer is the attested model key ✅, (d) quote report_data binds signer + nonce ✅, (e) RTMR3 event-log replay ✅, (f) MRCONFIGID = compose hash ✅, (g) Intel DCAP quote signature **not verified**, (h) NVIDIA GPU evidence **not verified**. The page says b–f are consistency only until (g). `ai.attestation.verified` stays `false`. Checked on the fixture and on the real stored run `run-Ngs7_871eapi` (same result). Field names re-checked against the live NEAR AI docs; recorded in docs/05 "Attestation checks".
- **Claim page:** 3-step indicator (Open link → Connect wallet → Get paid), shorter copy, "USDC on NEAR" first, pre-selected, blue edge + "Real on testnet" + "Recommended"; cross-chain option note "Estimated from live mainnet quote — delivery simulated on testnet." One banner (`CrossChainSimNotice`) on the claim page (when cross-chain options or a simulated claim show) and on the run page's claims list (when a simulated payout exists). Wording checked against the code (dry quote; contract pays the sim sink; the refund is the sim sink's real transfer back).
- **Landing page copy** no longer says "Cryptographic privacy end to end" / "confidential enclave"; it notes that off-chain still means the server can read the table.
- **"Or add payees by hand"** on the approver upload screen: name, wallet, amount, memo → an ordinary CSV (`apps/web/lib/client/payees.ts`) uploaded through the same pipeline (mapping, rules, review). With `NEAR_AI_LIVE=1` that is one mapping call per new list, like any new file.
- **Contract tests:** 20 new unit tests (claim_evm and claim_near_relayed on cancelled / unfunded / partly funded / paused runs, after the deadline, wrong proof, double claim; reopen by relayer, recipient or owner; malformed, wrong or unknown leaf hash / run). No contract bug found.
- **Docs:** README top (pitch, differentiators, "How a company uses this", real vs simulated with one row per attestation check and "Confidential payout rail: not built"), Future work; docs/05, 06 ("Roadmap: confidential payout rail", checked against the live NEAR Intents docs; unknowns written as "to be confirmed"), 08, 09 (new endpoint), 02.
- **Checked:** README contract IDs and both example transactions exist on testnet; the contract code hash on testnet is `d9e9c6fe…` (matches below).
- **NOT verified in a browser:** the new notices, the verify page's per-check list, the claim step indicator and the payee form (typecheck, lint, tests and a production build pass; pages and endpoints answered 200 on a local `pnpm start`).
- **Owner decision open:** adding an Intel DCAP verifier (e.g. Phala's `dcap-qvl`, WASM) — a new dependency that also needs Intel collateral from Intel PCS or a third-party PCCS. Not added.

### No terminal anywhere in the product (2026-11-12, uncommitted)
- **Deleted:** the copyable NEAR CLI commands in `chain-steps.tsx` (`SHOW_CLI`, the command strings, the `Cli` component), in development too.
- **Defaults:** approvers `tushar1962005.testnet` + `tushar-approver2.testnet`; refund account `tushar1962005.testnet`, replaceable with the new optional env `DEMO_ORG_REFUND_ACCOUNT` (an existing database row is updated at startup). Both apply to runs created afterwards. `tushar-approver2.testnet` exists on testnet (0.6 NEAR when checked on 2026-11-12), so the defaults work without `DEMO_ORG_APPROVERS`.
- **Reclaim unclaimed funds** (run page, section "On-chain"): `reclaim_unclaimed` from the approver's wallet; shows the unclaimed amount and the refund account read from the contract; disabled until the deadline. After everything was claimed it becomes "Close the run".
- **Cancel run:** `cancel_run`, shown to an on-chain approver while the run is Draft/Approved with 0 funded; asks for confirmation.
- **Claim window in minutes (10–180), test networks only**, chosen at Finalize, so reclaim can be tried the same day. Refused by the server on mainnet. The deadline is real.
- The run page now re-reads the contract once when it opens, so the unclaimed amount is current.
- Operator-only actions (`set_paused`, `set_relayer`) have no UI on purpose; documented in README and docs/12.
- **NOT verified in a browser:** the Reclaim and Cancel buttons (the contract methods themselves are covered by unit and sandbox tests). Docs updated: 02, 09, 12, README, `.env.example`.

### Gas-free NEAR claims (2026-11-12) — decision 6 is SETTLED: fallback B is built and live
- **Spike A did not succeed inside the hour.** Wallet Selector's Meteor module bundles `@meteorwallet/sdk` 1.0.24 (no delegate-action call at all). `@meteorwallet/sdk` 3.24.1 has `near::sign_delegate_actions`, bundles with esbuild (about 2.5 MB, needs `buffer`/`util` polyfills) and can sit next to Wallet Selector, but it keeps its own connection, so the claim page would need a second Meteor sign-in plus one more popup. No real signature could be obtained: `wallet.meteorwallet.app` blocks automated browsers (Cloudflare), so only the owner's wallet could prove it. Nothing from the spike is in the repo.
- **Built (B):** contract method `claim_near_relayed(run_key, leaf, proof)`: relayer only, NEAR leaves only, no payout argument, always pays USDC on NEAR to the leaf's own account. 15 unit tests + 1 sandbox test. `claim_near` is unchanged.
- **App:** a NEAR recipient who keeps the default receiver (their own account) presses "Claim (gas-free)" and signs nothing; `POST /submit {claimId}` makes the relayer send `claim_near_relayed`. A different receiver still uses `claim_near` from the wallet (recipient pays gas). Logic: `isRelayedNearClaim` in `apps/web/lib/server/claims.ts`.
- **Redeployed (code only, state unchanged):** `blindroll.blindroll-dev.testnet`, code hash `d9e9c6fed9c204557bb11cc46122ef4603cc85c6bbd3594e8974c82e7bd234d7`; `get_config` and run `run-Ngs7_871eapi` read back unchanged.
- **Proven on testnet:** `pnpm relayed:check` (new, `scripts/relayed-claim-check.mts`) on throwaway run `relayed-check-1794465265790`: relayer tx `7cLq3BTUQA3jpPXbYQUQwReqgyvw3coxjjHFow6VPr4w` succeeded, the recipient got exactly 1.25 mUSDC and its NEAR balance did not change; the same call signed by a non-relayer failed with "Only the relayer can call this".
- **NOT yet verified (needs the owner's browser):** the "Claim (gas-free)" button with a Meteor recipient.
- **Also fixed:** `POST /api/claim/:runKey/prepare` returned 400 for cross-chain options because it required `receiver`, which the page only sends for "USDC on NEAR". This would have blocked the owner's simulated "USDC on Base" test.
- Throwaway account `br-spike-1794464711.testnet` (faucet-funded, key in `~/.near-credentials/testnet/`) was created for these checks; it is the creator/approver of that throwaway run and can be ignored or deleted.
- Docs updated: 03, 04, 07, 09, 11, 12, README (gas-free wording, limitation reworded).

Simulated (labelled): cross-chain delivery on testnet and the delivery failure that triggers a refund. Everything else is real. See the README table.

### Claim flow (2026-11-11)
- Built: `/claim/<run_key>` → connect (any EIP-6963 EVM wallet, or Meteor for NEAR) → sign the view message → own row only → options board → enter a NEAR account → EVM: sign the claim message, the relayer submits `claim_evm` and pays gas; NEAR: `claim_near` sent from the recipient's wallet → status from the contract (`is_claimed`).
- Options board: "USDC on NEAR" is real. "USDC on Base / Arbitrum" show **real 1Click dry quotes** (mainnet prices, labelled estimated) and **cannot be chosen**.
- **SIMULATION approved by the owner (2026-11-11) and built:** 1Click delivery on testnet. Condition met in code: "refunded (simulated)" is a real `ft_transfer` from the sim sink back to the contract, and `reopen_claim` is only offered after that transaction succeeded. Details: docs/06 "Testnet behaviour". It is **inactive until `SIM_SINK_ACCOUNT_ID` and `SIM_SINK_PRIVATE_KEY` are set** (`pnpm env:check` shows whether they are).
- **The sim-sink account does not exist yet.** The owner asked to be asked first; a HELP NEEDED with the command was sent in chat (the owner runs it so the key never passes through an agent).
- **Verified:** claim services with real signatures and stubs for RPC/relayer (28 web tests); public claim endpoints over HTTP against the built app; `pnpm relayer:check` sent a real testnet transaction from `relayer.blindroll-dev.testnet` (`2Swt3527ecKYdd859HQZGCscWUkAaQCNtqLYgTjbwfVL`).
- **NOT yet verified (needs the owner's wallets):** a real claim in the browser (MetaMask view + claim signature through the relayer to the contract; Meteor NEAR view + `claim_near`).
- First browser test passed earlier the same day: run `run-Ngs7_871eapi` is Active, 2 of 2 approvals, 7,000.50 test USDC funded (its recipients are sample addresses nobody controls).
- Not built: 1Click execution path on mainnet (real quote, deposit submit, status polling). NEP-366 delegate actions are not used (see "Gas-free NEAR claims" above).

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
1. **Approvers:** #1 `tushar1962005.testnet`, #2 `tushar-approver2.testnet` (both Meteor, browser). Threshold 2. Refund account `tushar1962005.testnet`. No CLI step exists in the product (owner decision 2026-11-12).
2. **Keep both `reopen_claim` guards.**
3. **"Proving the refund"** (balance vs liabilities check in `reopen_claim`): don't build now. Revisit Nov 13 only if the MVP works end to end; otherwise list it in the README as a known limitation.
4. **CSV behaviours approved.** Add "currency defaulted to USDC" to the report when there's no currency column (do it in the report builder).
5. `relayer.blindroll-dev.testnet` already exists (2 NEAR); its key is `RELAYER_PRIVATE_KEY` in the env file. Never add a create step for it.

### Status of decisions 6–10 (2026-11-12)
| # | Status |
|---|---|
| 6 | **Done.** Spike A failed inside the hour; fallback B built, redeployed, proven on testnet (see "Gas-free NEAR claims" in section 2). Owner still has to press "Claim (gas-free)" once with a Meteor recipient |
| 7 | **Account created by the owner** (`tushar-approver2.testnet` exists, 0.6 NEAR). It is now a default approver in code; the two-approver browser test is still to do |
| 8 | **Worker part done.** Pre-push check clean; Railway settings in "Deploy on Railway" below; the hosted build was rehearsed from a clean copy. Nothing was pushed |
| 9 | **Built, off by default, not verified in a browser.** Intear and Sender (see "More wallets" below) |
| 10 | **Not started, on purpose.** The core is not done (owner's simulated test, hosted deploy, video), and 10(a) changes `reopen_claim`, which that simulated test exercises |

### More wallets (decision 9, 2026-11-12)
- The chosen claim path needs only an in-page NEP-413 `signMessage` made with a full-access key, plus `signAndSendTransaction` for approvers and for recipients who pay another account. Wired through Wallet Selector 10.1.4: **Meteor** (always on), **Intear** (`intear-wallet`) and **Sender** (`sender`).
- **Intear and Sender are OFF until `NEAR_WALLETS=intear-wallet,sender` (or one of them) is set**, because nobody has tested them in a browser. When more than one wallet is enabled, a "NEAR wallet:" picker appears next to the sign-in button and on the claim page; the choice is remembered per browser. Code: `apps/web/lib/client/wallet.ts`, `app/components/near-wallet-choice.tsx`, `enabledNearWallets` in `lib/server/config.ts`.
- **To verify each (owner, in a browser):** sign in as an approver, send one approver transaction, and view + claim as a recipient. Most likely failure: sign-in returns `key_not_owned` if the wallet signs messages with a key that is not a full-access key.
- Left out: MyNearWallet (redirect wallet: sign-in and `signMessage` leave the page, which the one-click connect → sign flow cannot follow) and HOT (pulls a large SDK with native add-ons).
- `pnpm-workspace.yaml` now lists `bufferutil` and `utf-8-validate` as not built. Without that, `pnpm install --frozen-lockfile` fails with `ERR_PNPM_IGNORED_BUILDS` (it would have failed on the host).

### Deploy on Railway (decision 8, 2026-11-12) — the owner pushes and deploys
**Pre-push check (run on 2026-11-12, all clean):** the only tracked env file is `.env.example`; no key, JWT or API key in any commit of the history or in the working tree (the `ed25519:` strings in `packages/core/test-vectors/ai/` are public signatures; the `0xac09…` key in tests is the public Hardhat key); `.env.local`, `data/`, `docs/samples/my-*.csv` are ignored and were never committed. `Near_build-UI-design/` is a separate git clone and is now in `.gitignore` (committing it would create a broken submodule entry). Repeat before pushing: `git ls-files | grep -iE "\.env|\.pem|\.sqlite|my-.*\.csv"` must print only `.env.example`.

**Railway service settings** (checked against docs.railway.com on 2026-11-12; `railway.json` is deprecated there, so use the dashboard):
| Setting | Value |
|---|---|
| Source | The GitHub repo, **root directory `/`** (the repo root, not `apps/web`) |
| Builder | Railpack (default). Node comes from `engines.node` = `24.x` in the root `package.json`; pnpm from `packageManager` |
| Build command | `pnpm build` (the install step is automatic: `pnpm install --frozen-lockfile`) |
| Start command | `pnpm start` (Next.js listens on Railway's `PORT`) |
| Volume | One volume, mount path `/data` |
| Replicas | 1. Never more: SQLite file, and Railway does not allow replicas with a volume |
| Public networking | Generate a domain |
| Healthcheck path | `/api/auth/me` (optional) |

**Variables (names only; values come from the local env file):** `NEAR_NETWORK`, `NEAR_RPC_URL`, `BLINDROLL_CONTRACT_ID`, `USDC_TOKEN_ID`, `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEY`, `NEAR_AI_API_KEY`, `NEAR_AI_BASE_URL`, `NEAR_AI_MODEL`, `NEAR_AI_LIVE`, `ONECLICK_BASE_URL`, `ONECLICK_JWT`, `ONECLICK_MODE`, `DATA_ENCRYPTION_KEY`, `SESSION_SECRET`, `APP_URL`, plus `BLINDROLL_DB_FILE=/data/blindroll.sqlite`. Optional: `DEMO_ORG_APPROVERS`, `SIM_SINK_ACCOUNT_ID`, `SIM_SINK_PRIVATE_KEY`, `NEAR_WALLETS`.
- **All 16 required variables must be set before the first build**: `next.config.ts` checks them at build time and the build fails with the names of the missing ones. Railway gives service variables to the build.
- `APP_URL` must be the exact public origin with `https://` and no path, e.g. `https://${{RAILWAY_PUBLIC_DOMAIN}}`. If it is wrong, every POST fails with `403 bad_origin` and the session cookie is not marked secure.
- Seal the secrets in Railway (`RELAYER_PRIVATE_KEY`, `SIM_SINK_PRIVATE_KEY`, `NEAR_AI_API_KEY`, `ONECLICK_JWT`, `DATA_ENCRYPTION_KEY`, `SESSION_SECRET`).
- `DATA_ENCRYPTION_KEY` and `SESSION_SECRET` can be new values for the host; the hosted database starts empty anyway. Changing `DATA_ENCRYPTION_KEY` later makes existing rows unreadable.
- `NEAR_AI_LIVE`: with `0`, a judge who uploads a file sees the manual mapping form, because the hosted database has no cached mapping. `1` makes one real call per new file (cached by CSV hash). Owner's choice; `1` shows the AI step.
- A redeploy has a few seconds of downtime (the volume can be mounted by one deployment at a time).
- **Rehearsed locally:** a copy holding only committable files, no env file, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm start` with placeholder variables: pages and API answered, the database file was created at `BLINDROLL_DB_FILE`, a foreign `Origin` got 403 and the `APP_URL` origin passed. Not rehearsed: Linux (no Docker on this machine), so the `better-sqlite3` native binary on the host is the one thing unproven.

### Owner decisions on 2026-11-11 (late)
6. **Gas-free NEAR claims: spike A, timeboxed to 1 hour.** Use `@meteorwallet/sdk` ONLY to sign the `claim_near` delegate action; keep Wallet Selector for sign-in, approve and fund if both can coexist on one page (if they can't, ask the owner before migrating everything). The backend must check the delegate action: sender = the leaf's NEAR account, receiver = our contract, a single FunctionCall to `claim_near`, no deposit, sensible gas and expiry.
   **If the spike fails, build B without asking again:** `claim_near_relayed(run_key, leaf, proof)` that requires `predecessor == self.relayer` (the relayer is already in the contract config with `set_relayer`, so no config change) and pays USDC on NEAR only to the leaf's own account. Add tests, redeploy the contract code to testnet (state unchanged), update docs/04 and docs/07. Say "gas-free claims" in the README only once it works.
7. **Second approver:** the owner is creating `tushar-approver2.testnet` in Meteor and will set `DEMO_ORG_APPROVERS=tushar1962005.testnet,tushar-approver2.testnet` in `.env.local`.
8. **GitHub and deploy are done by the owner.** The worker only helps: before the owner pushes, check that no secrets or env files are tracked and that `docs/samples/my-*.csv` is ignored; give exact Railway settings (volume, `BLINDROLL_DB_FILE`, `APP_URL`, build/start commands, variable list by name only); fix anything that breaks on the hosted build. Never push yourself.
9. **More wallets:** only after decision 6 is settled, and only wallets that work with the chosen claim path.
10. **Optional items are now confirmed in scope, after the core is done** (core = items 6–9 plus the owner's simulated test, hosted deploy, README and video). Order: (a) `reopen_claim` balance check that proves the refund arrived ("Open issue: proving the refund" in docs/04; contract change + tests + redeploy); (b) full NEAR AI attestation verification (Intel DCAP quote; see docs/05); (c) Confidential Intents payout rail, timeboxed to one day (docs/06, docs/08); (d) DAO/multisig approvals (SputnikDAO, Trezu; docs/12 "Later"). Stop and ship if the deadline gets close: the core always comes first.

## 4. Accounts and environment
| Item | Value |
|---|---|
| Dev/parent account | `blindroll-dev.testnet` (faucet-funded, ~2.7 NEAR left after the deploy; key in the macOS keychain via NEAR CLI) |
| Contract | `blindroll.blindroll-dev.testnet` (deployed) |
| Mock USDC | `usdc.blindroll-dev.testnet` (deployed) |
| Relayer | `relayer.blindroll-dev.testnet` |
| Sim sink (testnet-only simulation) | `sim-sink.blindroll-dev.testnet` — created by the owner on 2026-11-11 (0.5 NEAR); `SIM_SINK_ACCOUNT_ID` and `SIM_SINK_PRIVATE_KEY` are set. `pnpm simsink:check` (read-only) confirmed the key is a full-access key. Must never be set on mainnet |
| Approver #1 | `tushar1962005.testnet` (Meteor web wallet) |
| Approver #2 | `tushar-approver2.testnet` (Meteor; the owner is creating it). `blindroll-dev.testnet` is no longer an approver of new runs; it stays the contract owner (operator) |
| Refund account | `tushar1962005.testnet` by default; `DEMO_ORG_REFUND_ACCOUNT` replaces it |
| Owner's test recipients | A second Meteor testnet account and a MetaMask address (in the git-ignored `docs/samples/my-recipient-test.csv`; never commit it) |
| Tooling | cargo-near 0.23, NEAR CLI 0.31.1 (in `~/.cargo/bin`), Node 24, pnpm, Rust 1.96 (no pin needed) |

**Env file:** one file at the repo root, `near_bulid/.env.local` (git-ignored). `packages/core/src/env.ts` loads it for the app (`apps/web/next.config.ts`) and for scripts; `pnpm env:check` prints only the names of missing variables (all 16 set on 2026-11-11). Never print, log or commit values. A Claude Code hook blocks shell commands that name the file, so agents cannot read it; use `.env.example` for names.

Scripts in `scripts/` are `.mts` and run through `tsx` in `packages/core` (see the root `package.json` scripts).

## 5. Next steps, in order
1. **Owner:** re-test in the browser only what the review fixes touched (list in the 2026-11-12 review-fixes PROGRESS message): claim page (steps, notice, options, banner), run page (notice, claims list banner), verify page (per-check list), "Or add payees by hand".
2. **Owner:** push to GitHub, deploy on Railway with the settings in section 3. The worker fixes anything that breaks on the hosted build.
3. README: add the hosted URL (row "Hosted demo") and re-check every row after the deploy. Then the 2-minute video and submit by **14 Nov 2026 23:59 UTC**.
4. **Optional, owner:** test Intear and/or Sender, then set `NEAR_WALLETS`.
5. Only if time is left and the owner says yes: DCAP verification (needs a decision on `dcap-qvl` + collateral source), `reopen_claim` balance check (contract change + redeploy). Confidential Intents stays roadmap-only.

## 6. Open risks / known gaps
- **No CLI steps remain in the product.** Runs created before 2026-11-12 (for example `run-Ngs7_871eapi`) still have `blindroll-dev.testnet` as approver and refund account in the contract; use a new run for the browser-only test.
- **Intear and Sender are untested** and therefore off by default (`NEAR_WALLETS`).
- **Hosted build not yet run on Linux**; see "Deploy on Railway".
- **One NEAR wallet connection per browser** is shared by approver pages and the claim page. The claim page shows the remembered account and offers "Switch account"; wallet-sent transactions check the signer first (`ensureWalletAccount` in `apps/web/lib/client/wallet.ts`).
- **Export column `leaf_index`** is the Merkle tree position, not the row number of the uploaded file (the file row number is not stored after finalize). DAO/multisig approvals (SputnikDAO, Trezu) are a stretch goal listed there under "Later".
- AI attestation: signature plus five offline consistency checks (docs/05 "Attestation checks"); no Intel DCAP quote verification and no NVIDIA GPU evidence check, so `verified: false`.
- `reopen_claim` trusts that 1Click really refunded (see docs/04 "Open issue: proving the refund").
- 1Click has no testnet: cross-chain delivery on testnet is the owner-approved simulation with a real refund (docs/06); dry quotes are real.
- 1Click **dry** quote schema confirmed; the non-dry response (`depositAddress`, deadline fields) is still unconfirmed and needs an existing mainnet `refundTo`.
- Native mainnet USDC contract ID and its `storage_deposit` behaviour not yet confirmed.
- Gas-free NEAR claims rely on the relayer being the only caller of `claim_near_relayed`. A stolen relayer key could deliver NEAR payouts early to their rightful accounts (never redirect them); rotate with `set_relayer` (docs/11 T3).
- Confidential Intents: not built; roadmap only (docs/06 "Roadmap: confidential payout rail").

## 7. How to work with the owner
- Ask before simulating anything: send a **SIMULATION REQUEST** (what, why, where, labelling, what stays real, path to real).
- Report problems as **BLOCKER** (what tried, what happened, cause, options).
- Ask for things as **HELP NEEDED** (what, why, where to get it, where to put it, what happens next). Never ask for keys in chat.
- After each milestone send **PROGRESS** (done, tests, real vs simulated, next, need from you).
- Update this file before ending a session.
