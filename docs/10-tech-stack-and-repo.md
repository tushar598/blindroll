# 10 — Tech stack, repo layout and conventions

## Stack

| Layer | Choice | Why |
|---|---|---|
| Contract | Rust, `near-sdk` 5.x, `cargo-near` | Standard NEAR toolchain; has `env::ecrecover`, `env::ed25519_verify`, `env::keccak256`, `env::sha256` |
| Contract tests | Rust unit tests + `near-workspaces` 0.24 (sandbox) | Real cross-contract calls with a mock USDC. The sandbox test builds both wasm files with `cargo near build` first |
| Web + API | Next.js (App Router), TypeScript (strict), Tailwind CSS | One deployable for UI and backend |
| NEAR client | `@near-wallet-selector/core` + `meteor-wallet` in the browser; plain JSON-RPC `fetch` on the server | Wallet connect, NEP-413 sign-in, transactions; view calls need no SDK. Only Meteor is wired (the approver's wallet). `near-api-js` comes in with the relayer |
| EVM wallet | `wagmi` + `viem` | `personal_sign`, `verifyMessage` |
| Solana (stretch) | `@solana/wallet-adapter-*`, `tweetnacl`, `bs58` | |
| AI | `openai` SDK pointed at `https://cloud-api.near.ai/v1` | NEAR AI Cloud is OpenAI-compatible; use raw `fetch` where raw bytes are needed for signatures |
| CSV | `papaparse` | Robust parsing |
| Validation | `zod` | API inputs and AI outputs |
| Hashing / canonical JSON | Node `crypto`, `@noble/hashes`, `canonicalize` | sha256, keccak, RFC 8785 |
| DB | SQLite + `drizzle-orm` (`better-sqlite3`) | Zero setup |
| Tests (TS) | `vitest` | Fast |
| Package manager | `pnpm` workspaces | Monorepo |

Use the latest stable versions at build time and pin them in lockfiles. Don't add libraries beyond this list without a reason in the PR/commit.

## Repo layout

```
near_bulid/
├── AGENTS.md                      # rules for AI/human builders (read first)
├── README.md                      # judge-facing: problem, demo link, do X → see Y, real vs simulated
├── docs/                          # these specs
├── contracts/
│   ├── Cargo.toml                 # Cargo workspace for both contracts (shared target/ and lockfile)
│   ├── blindroll/                 # Rust contract (Cargo.toml, src/lib.rs, src/merkle.rs, src/sig.rs, src/tests.rs, tests/sandbox.rs)
│   └── mock-usdc/                 # NEP-141 test token, 6 decimals, open mint; refuses non-test account IDs
├── packages/
│   └── core/                      # pure TS logic
│       ├── src/csv/               # parse, normalize
│       ├── src/rules/             # R001..R011
│       ├── src/merkle/            # leaf, tree, proof (matches contract)
│       ├── src/report/            # canonical report builder + hash
│       ├── src/claims/            # view + claim message builders
│       ├── src/validate.ts        # shared input rules (docs/04 → Input validation)
│       ├── src/config.ts          # network/token guard (no mock USDC on mainnet)
│       ├── scripts/               # gen-vectors.ts (writes test-vectors/)
│       ├── src/ai/                # NEAR AI Cloud client, prompts, signature verify
│       ├── src/rails/             # near-usdc, oneclick, confidential (optional)
│       └── test-vectors/          # merkle.json, claim-message.json (shared with Rust tests)
├── apps/
│   └── web/                       # Next.js app (UI + API routes + DB)
│       ├── app/(approver)/…       # dashboard, run review, report
│       ├── app/claim/[runKey]/…   # recipient flow
│       ├── app/api/…              # see docs/09
│       └── db/                    # drizzle schema + migrations
├── scripts/                       # deploy, seed demo run, e2e testnet script
├── .env.example
└── pnpm-workspace.yaml
```

## Environment variables (`.env.example`)

One env file for everything: **`.env.local` at the repo root** (git-ignored), not inside `apps/web`. `packages/core/src/env.ts` (`@blindroll/core/env`) loads it and runs the startup check, which reports only the **names** of missing or empty variables. `apps/web/next.config.ts` calls it for the app; scripts call it directly; `pnpm env:check` runs it on its own.

```
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
BLINDROLL_CONTRACT_ID=blindroll.<your-account>.testnet
USDC_TOKEN_ID=usdc.<your-account>.testnet          # mock on testnet; native USDC on mainnet
RELAYER_ACCOUNT_ID=relayer.<your-account>.testnet
RELAYER_PRIVATE_KEY=ed25519:...                     # never commit
NEAR_AI_API_KEY=...                                 # NEAR Builders $10 key or a cloud.near.ai key; never commit
NEAR_AI_BASE_URL=https://cloud-api.near.ai/v1
NEAR_AI_MODEL=z-ai/glm-5.3-flash                    # small model; listed on docs.near.ai/cloud/models
NEAR_AI_LIVE=0                                      # 1 = allow live NEAR AI Cloud calls
ONECLICK_BASE_URL=https://1click.chaindefuser.com/v0
ONECLICK_JWT=...                                    # partners.near-intents.org
ONECLICK_MODE=dry                                   # dry | live (live only on mainnet)
DATA_ENCRYPTION_KEY=base64-32-bytes
SESSION_SECRET=...
APP_URL=http://localhost:3000
```

## Conventions

- Relative imports inside `packages/core` use the real `.ts` extension (`allowImportingTsExtensions`), because the Next.js bundler does not map `.js` to `.ts` for workspace sources. `vitest`, `tsx` and Node handle it.
- `apps/web`: server code in `lib/server/` (services take the database as an argument, so `vitest` runs them against `:memory:`), browser code in `lib/client/`, route handlers in `app/api/` wrapped by `handle()` in `lib/server/http.ts`. Read `apps/web/AGENTS.md` before touching Next.js code: this Next.js version differs from older ones.

- TypeScript `strict: true`; no `any` in `packages/core`.
- All amounts are `bigint` base units in TS and `u128` in Rust; strings at API boundaries.
- Hex is lowercase, no `0x` prefix, except EVM addresses and EVM signatures.
- Every function that touches money or hashing has unit tests.
- Simulated data always carries `simulated: true`, and the UI shows a "Simulated" badge.
- Commit small, working steps. Keep `README.md` updated with what's real.
