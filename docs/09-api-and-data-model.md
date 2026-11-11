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
| GET | `/api/auth/me` | `{accountId | null, network, contractId, tokenId, aiLive, org}` for the UI |

Sign-in details as built: the nonce is 32 random bytes (base64); the signed message is `"Sign in to Blindroll as an approver"`, recipient `"blindroll"`, no callback URL; the key must be a **full-access** key of the account; the account must be an approver of an org. Cookie-authenticated writes are refused when the `Origin` header is another site.

### Runs (approver session)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/runs` | Runs of the approver's orgs |
| POST | `/api/runs` | multipart `file` (CSV) + `name` + `orgId` → `{runKey, mapping}` where `mapping` is `cached` (same `csv_sha256` mapped before), `live` (one NEAR AI Cloud call, only when `NEAR_AI_LIVE=1`), `ai_off` or `ai_failed` (the last two → status `needs_mapping`) |
| GET | `/api/runs/:runKey` | Run, rows (decrypted), findings, edits, summary, finalized values, last on-chain view |
| PUT | `/api/runs/:runKey/mapping` | Manual column mapping (same JSON shape as the AI output); clears edits and overrides |
| POST | `/api/runs/:runKey/edits` | `{kind:"set", rowNumber, column, value}` or `{kind:"remove", rowNumber, reason}` (logged; replaces `PATCH …/rows/:rowId`, because edits are applied to the uploaded cells and the whole table is re-checked) |
| POST | `/api/runs/:runKey/overrides` | `{findingId, reason}` accept a warning; `findingId` = `<rule_id>:<rowNumber | "run">` |
| POST | `/api/runs/:runKey/finalize` | Locks rows, builds leaves, Merkle root and report → `{merkleRoot, reportHash, totalAmount, recipientCount}` |
| GET | `/api/runs/:runKey/create-args` | `{contractId, args, depositYocto}`: exact arguments for `create_run` (the approver's wallet signs it) and the storage deposit to attach (0.05 NEAR + 0.00225 NEAR per recipient; the contract refunds the unused part) |
| POST | `/api/runs/:runKey/sync` | Reads `get_run` from the contract and updates the DB; refuses (`409 chain_mismatch`) if the on-chain run has another Merkle root or report hash |

Run `status`: `needs_mapping` → `review` → `finalized` → then the on-chain status in lowercase (`draft`, `approved`, `active`, `closed`, `cancelled`). `finalize` body: `{claimDays}` (1–365, default 14).
| GET | `/api/runs/:runKey/export?format=csv|json` | Reconciled export |

### Report (public read)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/runs/:runKey/report` | The canonical report JSON (no salaries; see [05](05-ai-pipeline-and-attestation.md)) |

### Claim (recipient)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/claim/:runKey` | Public run info: org name, run name, deadline, status |
| POST | `/api/claim/:runKey/view` | `{chain, address, signature, message}` → own row (amount, memo, status) + view token, or `404 not_listed` |
| GET | `/api/claim/:runKey/options` | Payout options with estimated amounts (1Click dry quotes, cached 30 s) |
| POST | `/api/claim/:runKey/prepare` | `{option, destinationAddress}` → for 1Click: real quote (`depositAddress`, `amountOut`, `minAmountOut`, `deadline`); then the exact claim message to sign, plus leaf, salt and proof |
| POST | `/api/claim/:runKey/submit` | `{signature}` (EVM) or `{signedDelegate}` (NEAR) → relayer submits → `{txHash}` |
| GET | `/api/claim/:runKey/status` | Claim + payout status for this recipient |

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
- `runs` also has `enc_csv` (the uploaded file, AES-256-GCM), `enc_mapping`, `mapping_source` (`ai` | `manual`), `ai_call_id`, `report_json` (the canonical report), `chain_json` (last on-chain view).
- `findings` is not a table: findings are recomputed from the CSV, mapping, edits and overrides (`reviewRun`), so they cannot go stale.
- `row_edits(id, run_id, by_account, enc_edit, created_at)`: the ordered, encrypted edit log. `overrides(run_id, rule_id, row_number, by_account, enc_reason, created_at)`, unique per finding.
- `ai_calls` is keyed by `csv_sha256` (the cache): `enc_evidence` holds the request body, raw response bytes, signature and checks; `attestation_json` holds the raw preflight report.
- `run_rows` are written at finalize, ordered by leaf hash.
- Database file: `<repo root>/data/blindroll.sqlite` (git-ignored); `BLINDROLL_DB_FILE` overrides it for tests.

- `chain`, `address`, `amount` are stored in plaintext because they're needed for lookups and proofs. Everything identifying (names, emails, memos) goes in `enc_payload`.
- Encryption key: `DATA_ENCRYPTION_KEY` (32 bytes, base64) from the environment.
