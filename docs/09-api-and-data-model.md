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

### Runs (approver session)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/runs` | multipart CSV upload + `{name, orgId}` → `{runKey}`; starts AI mapping |
| GET | `/api/runs/:runKey` | Run, rows (decrypted), findings, overrides, status |
| PATCH | `/api/runs/:runKey/rows/:rowId` | Edit a row (logged) |
| POST | `/api/runs/:runKey/overrides` | `{findingId, reason}` accept a warning |
| POST | `/api/runs/:runKey/finalize` | Locks rows, builds leaves, Merkle root and report → `{merkleRoot, reportHash, totalAmount, recipientCount}` |
| GET | `/api/runs/:runKey/create-args` | Exact arguments for `create_run` (the approver's wallet signs it) |
| POST | `/api/runs/:runKey/sync` | Reads on-chain run state and updates the DB |
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

- `chain`, `address`, `amount` are stored in plaintext because they're needed for lookups and proofs. Everything identifying (names, emails, memos) goes in `enc_payload`.
- Encryption key: `DATA_ENCRYPTION_KEY` (32 bytes, base64) from the environment.
