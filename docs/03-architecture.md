# 03 — Architecture

## Components

```
┌──────────────────────────── apps/web (Next.js) ─────────────────────────────┐
│  Approver UI        Claim UI            Report/Verify UI      API routes     │
│  (NEAR wallet)      (EVM / NEAR wallet) (public, read-only)   (backend)      │
└───────┬───────────────────┬─────────────────────┬───────────────┬───────────┘
        │                   │                     │               │
        │                   │                     │      ┌────────┴─────────┐
        │                   │                     │      │ packages/core    │
        │                   │                     │      │ csv, rules,      │
        │                   │                     │      │ merkle, report,  │
        │                   │                     │      │ messages, rails  │
        │                   │                     │      └────────┬─────────┘
        ▼                   ▼                     ▼               │
┌────────────────┐  ┌────────────────┐  ┌──────────────────┐  ┌───┴─────────────┐
│ Blindroll      │  │ NEAR AI Cloud  │  │ 1Click API       │  │ SQLite DB       │
│ contract (Rust)│  │ (TEE, signed)  │  │ (NEAR Intents)   │  │ (encrypted rows)│
│ + USDC NEP-141 │  └────────────────┘  └──────────────────┘  └─────────────────┘
└────────────────┘
        ▲
        │ relayer account submits claims, pays gas
```

| Component | Responsibility |
|---|---|
| **Blindroll contract** | Holds USDC per run, stores Merkle root and report hash, approvals, verifies claim signatures and proofs, pays out, reclaim after deadline |
| **USDC (NEP-141)** | Native USDC on mainnet; a mock 6-decimal token on testnet |
| **Web app** | Approver dashboard, claim page, report/verify page |
| **API routes (backend)** | Auth, CSV intake, AI calls, Merkle/report building, quotes, relayer, 1Click status polling, exports |
| **packages/core** | Pure TypeScript logic shared by the API and tests: CSV parsing, rules, Merkle, canonical report, claim message builder, rail clients |
| **NEAR AI Cloud** | OpenAI-compatible inference in TEEs; returns signed responses |
| **1Click API** | Quotes and cross-chain delivery |
| **Relayer** | A dedicated NEAR account with a small balance; submits claim transactions: `claim_evm` with the recipient's signature, `claim_near_relayed` for NEAR recipients (NEP-366 delegate actions are not used, see [07](07-wallet-verification-and-claims.md)) |
| **Database** | Orgs, runs, encrypted rows, overrides, claims, payout status, audit log |

## Trust boundaries

| Boundary | Trusted for | Not trusted for |
|---|---|---|
| Contract | Custody, authorization, double-claim prevention | — |
| Backend | Confidentiality of plaintext (MVP), building quotes, submitting txs | Moving funds without a valid signature or proof |
| Relayer | Paying gas, liveness; for NEAR leaves, *when* `claim_near_relayed` is sent | Choosing payout targets (EVM: the signature binds them; NEAR relayed: the contract pays only the leaf's own account) |
| NEAR AI Cloud | Mapping suggestions | Payment decisions (code decides) |
| 1Click | Delivery | Correct amount (checked via `minAmountOut`, status and refunds) |

## Data flow per run

1. **Upload** → raw CSV bytes hashed (`csv_sha256`), stored encrypted.
2. **AI mapping** → request and response bytes kept raw for signature verification.
3. **Normalize + rules** → normalized rows, findings, `table_sha256`.
4. **Leaves** → each row gets a random salt; leaf hashes computed; Merkle tree built; `merkle_root`.
5. **Report** → canonical JSON (RFC 8785) → `report_sha256`.
6. **On-chain** → `create_run(run_key, merkle_root, report_sha256, totals, approvers, threshold, deadline, refund_account)`.
7. **Approve + fund** → run `Active`.
8. **Claim** → backend returns the leaf, salt and proof to the verified recipient; recipient signs; relayer submits; contract pays.
9. **Track** → 1Click status polled until terminal; refunds reopen claims (approver action).
10. **Export** → join DB rows with on-chain claim events.

## Networks

| Network | Use |
|---|---|
| NEAR **testnet** | Default for development and the public demo; mock USDC; the NEAR USDC rail is real; the 1Click rail runs dry quotes only and execution is **simulated** (1Click has no testnet) |
| NEAR **mainnet** | Stretch: one small real run with native USDC and a real 1Click payout, recorded for the demo video |

Make the network a single config switch (`NEAR_NETWORK=testnet|mainnet`).
