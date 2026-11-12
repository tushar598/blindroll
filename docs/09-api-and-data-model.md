# 09 — API and data model

Backend = Next.js API routes in `apps/web/app/api/`. JSON in and out. Every response that contains simulated data includes `"simulated": true`.

## Auth

| Session | How |
|---|---|
| **Approver** | NEAR wallet signs a NEP-413 message (`recipient: "blindroll"`, nonce from `/api/auth/nonce`). Backend verifies the signature and that the public key is an access key of the account (RPC `view_access_key`). Issues an HTTP-only session cookie (JWT, 8 h) |
| **Recipient view** | Per run: wallet signs the view message ([07](07-wallet-verification-and-claims.md)). Backend verifies and issues a short-lived token scoped to `(run_key, chain, address)` |

## Endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/nonce` | Returns a one-time nonce (5 min) |
| POST | `/api/auth/near` | `{accountId, publicKey, signature, message, nonce}` → approver session |
| POST | `/api/auth/logout` | |
| GET | `/api/auth/me` | `{accountId | null, network, contractId, tokenId, aiLive, org, wallets, sandbox}` for the UI. `org` is the org this session works in (the demo org, or the account's sandbox org). `sandbox`: `{enabled, active, limits}` (see [Judge sandbox](#judge-sandbox)) |

Sign-in details as built: the nonce is 32 random bytes (base64); the signed message is `"Sign in to Blindroll as an approver"`, recipient `"blindroll"`, no callback URL; the key must be a **full-access** key of the account; the account must be an approver of an org, or, with `JUDGE_SANDBOX=1`, it gets its own sandbox org (see [Judge sandbox](#judge-sandbox)). Cookie-authenticated writes are refused when the `Origin` header is another site.

### Runs (approver session)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/runs` | Runs of the approver's orgs |
| POST | `/api/runs` | multipart `file` (CSV) + `name` + `orgId` → `{runKey, mapping}` where `mapping` is `cached` (same `csv_sha256` mapped before), `live` (one NEAR AI Cloud call, only when `NEAR_AI_LIVE=1`), `ai_off`, `ai_failed` or `ai_limit` (a sandbox AI limit was reached, so no call was made); the last three → status `needs_mapping`. Also `fixed` for hand-typed payees (`source=payees`, no AI call) |
| GET | `/api/runs/:runKey` | Run, rows (decrypted), findings, edits, summary, finalized values, last on-chain view, `mappingNote` (the upload's `mapping` value) and `sandbox` (true for a sandbox run) |
| PUT | `/api/runs/:runKey/mapping` | Manual column mapping (same JSON shape as the AI output); clears edits and overrides |
| POST | `/api/runs/:runKey/edits` | `{kind:"set", rowNumber, column, value}` or `{kind:"remove", rowNumber, reason}` (logged; replaces `PATCH …/rows/:rowId`, because edits are applied to the uploaded cells and the whole table is re-checked) |
| POST | `/api/runs/:runKey/overrides` | `{findingId, reason}` accept a warning; `findingId` = `<rule_id>:<rowNumber | "run">` |
| POST | `/api/runs/:runKey/finalize` | Locks rows, builds leaves, Merkle root and report → `{merkleRoot, reportHash, totalAmount, recipientCount}` |
| GET | `/api/runs/:runKey/create-args` | `{contractId, args, depositYocto}`: exact arguments for `create_run` (the approver's wallet signs it) and the storage deposit to attach (0.05 NEAR + 0.00225 NEAR per recipient; the contract refunds the unused part) |
| POST | `/api/runs/:runKey/sync` | Reads `get_run` from the contract and updates the DB; refuses (`409 chain_mismatch`) if the on-chain run has another Merkle root or report hash |

Run `status`: `needs_mapping` → `review` → `finalized` → then the on-chain status in lowercase (`draft`, `approved`, `active`, `closed`, `cancelled`). `finalize` body: `{claimDays}` (1–365, default 14), or on test networks only `{claimMinutes}` (10–180; refused on mainnet), which exists to try the reclaim step without waiting days. With an empty body a sandbox run gets 15 minutes.
| GET | `/api/runs/:runKey/export?format=csv|json` | Reconciled export (approvers only; CSV by default). One row per recipient: `leaf_index, name, role, memo, chain, address, amount, amount_base_units, status, payout_rail, destination, destination_asset, claim_tx, deposit_address, final_status, refund_tx, reopen_tx, simulated`. `status` is `claimed | unclaimed | refunded | reopened`; whether a row is claimed is read from the contract (`is_claimed`). `leaf_index` is the position in the Merkle tree (leaves are ordered by leaf hash), not the row number in the uploaded file. Text cells that a spreadsheet would treat as a formula get a leading apostrophe |

### Payouts (approver session)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/runs/:runKey/payouts` | Confirmed claims with payout state; simulated ones carry `simulated: true` |
| POST | `/api/runs/:runKey/payouts/:claimId/refund` | Testnet simulation of a failed delivery; sends the **real** refund transfer from the sim sink → `{payoutStatus, refundTx, simulated: true}` |
| GET | `/api/runs/:runKey/payouts/:claimId/reopen` | The `reopen_claim` call for the approver's wallet; `409 not_refunded` until the refund transfer exists |
| POST | `/api/runs/:runKey/payouts/:claimId/reopen` | `{txHash}`; recorded once the contract shows the leaf unclaimed |

### Report (public read)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/runs/:runKey/report` | The canonical report JSON (no salaries; see [05](05-ai-pipeline-and-attestation.md)) |
| GET | `/api/runs/:runKey/attestation` | Public. The raw NEAR AI Cloud attestation stored for a finalized run, byte for byte (its sha256 is `ai.attestation.sha256` in the report). No payroll data. 404 when the run is not finalized or was mapped by hand. Used by the verify page's offline checks ([05](05-ai-pipeline-and-attestation.md#attestation-checks-2026-11-12)) |

### Claim (recipient)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/claim/:runKey` | Public run info: org name, run name, deadline, status, network, contract, and `createTx` (the `create_run` transaction that stored the report hash) |
| GET | `/api/claim/:runKey/challenge` | `{nonce, issued, recipient}` for the view message |
| POST | `/api/claim/:runKey/view` | `{chain, address, nonce, issued, signature, publicKey?}` (the server rebuilds the message) → `{row, token}`: own row (amount, name, memo, claim status) + view token, or `404 not_listed`. The token is sent as `Authorization: Bearer …` to the endpoints below |
| GET | `/api/claim/:runKey/options` | Payout options with estimated amounts (1Click dry quotes, cached 30 s) |
| POST | `/api/claim/:runKey/prepare` | `{optionId, receiver?}` (`receiver` is used only by `near-usdc`) → EVM: `{kind:"evm", claimId, message, expiresAtMs, summary}` (the exact claim message to sign). NEAR, receiver = own account: `{kind:"near", claimId, relayed:true, call:null, summary}` (gas-free, nothing to sign). NEAR, another receiver: `{kind:"near", claimId, relayed:false, call, summary}` (the `claim_near` call with leaf, salt and proof). Only `optionId: "near-usdc"` is accepted in this version; the 1Click path (real quote, `depositAddress`) is not built |
| POST | `/api/claim/:runKey/submit` | EVM: `{claimId, signature}` → relayer submits `claim_evm`. NEAR relayed: `{claimId}` → relayer submits `claim_near_relayed`. NEAR direct: `{claimId, txHash}` after the wallet sent `claim_near`. → `{status, txHash, simulated}`; `502 claim_failed` if the contract did not record the claim. Sandbox runs only: `429 sandbox_relay_limit`, `503 relayer_low_balance` (nothing was sent; the payout stays claimable) |
| GET | `/api/claim/:runKey/status` | Claim + payout status for this recipient |

### Judge sandbox

A demo device for **test networks only**, off by default. Owner request 2026-11-12; no contract change (`create_run` already accepts threshold 1).

| Env | Default | Meaning |
|---|---|---|
| `JUDGE_SANDBOX` | empty (off) | `1` = an account that is not an approver of a real org gets a sandbox org at sign-in. The server refuses to start with `JUDGE_SANDBOX=1` and `NEAR_NETWORK=mainnet` (`next.config.ts` → `assertStartupEnv`, and `assertNetworkConfig`). Turning it off ends sandbox sessions on their next request; their rows stay in the database |
| `SANDBOX_AI_DAILY_CAP` | 40 | Live NEAR AI Cloud mapping calls per UTC day across all sandbox accounts (0 disables live AI for sandboxes) |

Sandbox org: id `sandbox:<accountId>`, name `Sandbox – <accountId>`, approvers `[accountId]`, threshold 1, refund account `accountId`. Implicit (64-hex) accounts are refused. A demo-org approver never gets one.

| Limit (per sandbox account, UTC day) | Value | Where | Error |
|---|---|---|---|
| Runs started | 5 | `POST /api/runs` | `429 sandbox_run_limit` |
| Rows per run | 10 | `POST /api/runs` | `400 sandbox_row_limit` |
| Total per run | 1,000 USDC (`1000000000` base units) | `POST …/finalize`, `GET …/create-args` | `400 sandbox_total_limit` |
| Live AI mappings | 2 per account, `SANDBOX_AI_DAILY_CAP` over all sandboxes | `POST /api/runs` | none: `mapping: "ai_limit"`, manual form. The cache by `csv_sha256` still applies; hand-typed payees never call the AI |
| Relayed (gas-free) claims | 5, counted for the sandbox owner whoever the recipient is (EVM and NEAR) | `POST /api/claim/:runKey/submit` | `429 sandbox_relay_limit` |
| Relayer balance | at least 1 NEAR before each sandbox relay | same | `503 relayer_low_balance` |

These limits apply only to sandbox orgs, never to the demo org. Counted when attempted: an AI call or a relay that fails still counts. Isolation: every approver endpoint loads the run and checks that the signed-in account is an approver of **that run's org** (`403 forbidden` otherwise); the public claim, report and attestation endpoints are unchanged.

### Internal
| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/poll-payouts` | Cron/interval: poll 1Click `/v0/status` for non-terminal payouts; call `/v0/deposit/submit` after claims |

## Database (SQLite + Drizzle)

```
orgs(id, name, created_at)
org_approvers(org_id, account_id)

runs(id, run_key UNIQUE, org_id, name, status, network,
     csv_sha256, table_sha256, merkle_root, report_sha256,
     total_amount, recipient_count, claim_deadline_ms,
     contract_id, create_tx, created_by, created_at, finalized_at)

run_rows(id, run_id, row_index,
         enc_payload,               -- AES-256-GCM JSON: name, email, role, memo, original row
         chain, address, amount, salt_hex, leaf_hash,
         proof_json, status)        -- pending|claimed|refunded|reopened|unclaimed

findings(id, run_id, row_id NULL, rule_id, severity, message, data_json)
overrides(id, finding_id, by_account, reason, created_at)
row_edits(id, row_id, by_account, before_json, after_json, created_at)

ai_calls(id, run_id, model, chat_id, request_sha256, response_sha256,
         signature_json, attestation_json, verified BOOLEAN, created_at)

claims(id, run_id, row_id, payout_kind, payout_target,
       quote_json, claim_tx, status, created_at)       -- submitted|confirmed|failed
payouts(id, claim_id, rail, deposit_address, oneclick_status,
        amount_out, destination_asset, destination_address,
        status_json, updated_at)

audit_log(id, actor, action, run_id, data_json, created_at)
nonces(nonce, purpose, expires_at, used)
```

Differences in the built schema (`apps/web/lib/server/db.ts`; tables are created at startup, no migration tool):
- `orgs` also has `threshold` and `refund_account`; `org_approvers` has `position` (the approver order used in `create_run`). The demo org is seeded from `DEMO_ORG` in `lib/server/config.ts`.
- `runs` also has `enc_csv` (the uploaded file, AES-256-GCM), `enc_mapping`, `mapping_source` (`ai` | `manual` | `fixed`: hand-typed payees, read with the fixed payee mapping, no AI call; the report notes "AI mapping not needed: fixed columns (payees added by hand)"), `ai_call_id`, `report_json` (the canonical report), `chain_json` (last on-chain view).
- `findings` is not a table: findings are recomputed from the CSV, mapping, edits and overrides (`reviewRun`), so they cannot go stale.
- `row_edits(id, run_id, by_account, enc_edit, created_at)`: the ordered, encrypted edit log. `overrides(run_id, rule_id, row_number, by_account, enc_reason, created_at)`, unique per finding.
- `ai_calls` is keyed by `csv_sha256` (the cache): `enc_evidence` holds the request body, raw response bytes, signature and checks; `attestation_json` holds the raw preflight report.
- `run_rows` are written at finalize, ordered by leaf hash.
- `claims(id, run_id, row_id, option_id, payout_kind, payout_target, destination_asset, destination_address, expires_at_ms, message, claim_tx, status, error, simulated, created_at, updated_at)`; status `prepared` → `submitted` → `confirmed` | `failed`. Payout state lives on the claim (no separate `payouts` table yet): `payout_status` (`delivered_simulated` → `refunding` → `refunded_simulated` → `reopened`), `quote_json`, `refund_tx`, `reopen_tx`. Columns added after the first version are created at startup with `ALTER TABLE`.
- Public claim endpoints are rate-limited per IP in memory. A run that is not on-chain yet answers `404` like an unknown run.
- `runs.mapping_note` (added with `ALTER TABLE` at startup, null on older rows): the upload's `mapping` value (`cached | live | ai_off | ai_failed | ai_limit | fixed`).
- `sandbox_usage(account_id, day, kind, count)`, unique per `(account_id, day, kind)`; `kind` is `ai` or `relay`, `day` is the UTC date. Created with `CREATE TABLE IF NOT EXISTS`, so an existing database gains it at startup without touching other tables. Runs per day are counted from `runs.created_at`. It holds account IDs only.
- Database file: `<repo root>/data/blindroll.sqlite` (git-ignored); `BLINDROLL_DB_FILE` overrides it for tests.

- `chain`, `address`, `amount` are stored in plaintext because they're needed for lookups and proofs. Everything identifying (names, emails, memos) goes in `enc_payload`.
- Encryption key: `DATA_ENCRYPTION_KEY` (32 bytes, base64) from the environment.
