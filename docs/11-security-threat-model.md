# 11 — Security and threat model

| # | Threat | Impact | Mitigation |
|---|---|---|---|
| T1 | Compromised backend changes rows before finalization | Pays wrong address/amount | Approvers review the final table; the report and root are shown before `create_run`; M-of-N approvals |
| T2 | Compromised backend shows a fake 1Click deposit address | Recipient's payout stolen | The target is in the signed claim message and shown in the wallet prompt; the UI displays the 1Click explorer link. Residual risk: documented |
| T3 | Relayer key stolen | Gas drained | Low balance, alerts. It can't move run funds (claims need signatures or the recipient as predecessor; reopen needs an approver) |
| T4 | Relayer or front-runner redirects a claim | Funds stolen | Payout target is signed (EVM) or the predecessor is the recipient (NEAR) |
| T5 | Replay of a claim | Double payment | `claimed` set per `(run_key, leaf)`; `expires_at_ms` |
| T6 | Cross-run drain | One run pays another's claims | Per-run `funded_amount` / `claimed_amount` accounting |
| T7 | Prompt injection in CSV cells | AI produces a bad mapping | The AI only returns a column mapping validated by schema; code applies it; the AI never sees or decides amounts or payments; approvers review |
| T8 | Address poisoning / typos | Wrong recipient | Recipients must sign with the listed address to claim; `R001`, `R008` rules |
| T9 | Membership probing | Learn who's on payroll | Row data only after a valid signature from that address; generic "not listed" response; rate limits |
| T10 | Approver collusion | Fraudulent payroll | Threshold approvals; report with overrides and reasons; public on-chain approvals |
| T11 | Failed `ft_transfer` (unregistered account) | Funds stuck or claim lost | `storage_deposit` before transfer; callback reverts the claim on failure |
| T12 | 1Click refund | Funds back in contract, claim marked done | `refundTo` = contract; approver `reopen_claim` after status `REFUNDED` |
| T13 | Phishing claim sites | Signature for a wrong target | Message includes the contract ID and target; the UI shows the official domain; nothing to sign without a quote review |
| T14 | Secret leakage | Key compromise | `.env` never committed; `.env.example` only; keys from env at runtime |
| T15 | Plaintext data breach (backend DB) | Salaries exposed | AES-256-GCM for identifying fields; minimal retention; documented as an MVP trust assumption |
| T16 | Storage deposit drain via many new targets | NEAR balance drained | Reserve check in the contract; relayer rate limits |
| T17 | Overfunding | Funds stuck | `ft_on_transfer` returns the excess |

## Rules for builders

- Never log decrypted rows, private keys, JWTs or API keys.
- Validate every external input with Zod (API) and explicit checks (contract).
- All money math is integer base units (`bigint` in TS, `u128` in Rust). No floats.
- Contract: `#[private]` on callbacks, `assert_one_yocto` where relevant, check `predecessor` for `ft_on_transfer`.
- Run `cargo clippy` and the full test suite before every deploy.
