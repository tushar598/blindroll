# 02 — User flows

## End-to-end flow

```
Approver                       Blindroll backend            NEAR AI Cloud (TEE)     Blindroll contract        Recipient
   |  sign in (NEAR wallet)          |                              |                       |                     |
   |  upload CSV  ------------------>|  parse + send for mapping -->|                       |                     |
   |                                 |<-- mapping JSON + signature--|                       |                     |
   |                                 |  apply mapping, run rules    |                       |                     |
   |<-- table + flags + report ------|  build Merkle tree + report  |                       |                     |
   |  fix / override (reason logged) |                              |                       |                     |
   |  create_run(root, report_hash) ------------------------------------------------------->|                     |
   |  approve_run (M of N) ------------------------------------------------------------------>|                     |
   |  fund: USDC ft_transfer_call ----------------------------------------------------------->|  status = Active    |
   |                                 |                              |                       |                     |
   |                                 |<------------- open claim page, connect wallet, sign "view" message ----------|
   |                                 |-- own row + Merkle proof + live payout estimates ----------------------------->|
   |                                 |<------------- choose payout, sign claim message -----------------------------|
   |                                 |  relayer: claim_*(...) -------------------------------->|  verify sig + proof |
   |                                 |                              |                       |  ft_transfer ------>| (or 1Click deposit)
   |                                 |  track 1Click status, receipts --------------------------------------------->|
   |<-- reconciled export ----------|                              |                       |                     |
```

## Flow A — Approver: create a run

1. **Sign in.** Connect a NEAR wallet. The backend verifies a NEP-413 signed message and checks that the account is an approver for the organization.
2. **Upload CSV.** Any column names, any order. Max 500 rows for MVP. Or **add payees by hand** (name, wallet, amount, memo) on the same screen: the browser turns them into an ordinary CSV (`apps/web/lib/client/payees.ts`) and uploads it, so it goes through the same mapping, rules and review (with `NEAR_AI_LIVE=1` that is one mapping call, like any new file). No invoice parsing.
3. **Private AI cleanup.** The backend sends the header plus sample rows to NEAR AI Cloud. The model returns a column mapping and value normalization hints as strict JSON. Code applies them. (See [05](05-ai-pipeline-and-attestation.md).)
4. **Review table.** One row per recipient: name, chain, address, amount (USDC), role/memo, and flags. Flags are colored: `error` blocks the run, `warning` needs an override reason.
5. **Fix or override.** The approver edits a row or marks a warning as accepted, with a reason. Every change is logged and included in the report.
6. **Generate report.** The backend builds the Merkle tree and the attested report, then shows the report hash and Merkle root.
7. **Create run on-chain.** The approver presses **Create run from my wallet**: `create_run` with the root, totals, report hash, approvers list, threshold, claim deadline and refund account.
8. **Approve.** Each approver signs in with their own wallet and presses **Approve from my wallet** (`approve_run`). When approvals reach the threshold, the run is `Approved`.
9. **Fund.** An approver presses **Fund … USDC from my wallet**: `ft_transfer_call` to the contract with `msg = {"fund_run":"<run_key>"}`. On testnet, **Get test USDC** mints the test token to that wallet first. When fully funded, the run becomes `Active`.
10. **Share the claim link** (`/claim/<run_key>`) in Discord/Telegram. The link reveals nothing by itself.
11. **Cancel (optional, before funding).** While the run is `Draft` or `Approved` and holds no funds, an approver can press **Cancel run** (`cancel_run`). A cancelled run cannot be funded or claimed.
12. **Reclaim (after the deadline).** An approver presses **Reclaim unclaimed funds** (`reclaim_unclaimed`). The page shows the unclaimed amount and the refund account stored in the contract; the button is disabled until the claim deadline has passed. The run becomes `Closed`.

**Every step above is a browser-wallet action. The product has no terminal step** (as built 2026-11-12). The contract owner's `set_paused` and `set_relayer` are operator actions outside the user flow; see [12](12-build-plan.md) → "Operator-only actions".

## Flow B — Recipient: claim

1. Open `/claim/<run_key>`. The page shows the organization name, run name and deadline. No amounts, no list. A 3-step indicator (Open link → Connect wallet → Get paid) and the trust notice ("The Blindroll server can read the full payroll table…", docs/08) are shown at the top. "USDC on NEAR" is pre-selected and marked "Real on testnet"; cross-chain options carry "Estimated from live mainnet quote — delivery simulated on testnet" and a single simulation banner (docs/06).
2. **Connect wallet.** EVM (MetaMask etc.) or NEAR. Solana is a stretch goal.
3. **Sign a "view" message** (no gas). The backend verifies the signature and checks whether the address is in the run.
   - Not listed: "This wallet isn't in this payroll run." Nothing else is revealed.
   - Listed: show only this recipient's row: amount, memo, status.
4. **Choose payout.** A board lists the options with estimated amounts from live 1Click dry quotes, e.g.:
   | Option | You'd receive (est.) | Fee | Time |
   |---|---|---|---|
   | USDC on NEAR | 1,000.00 USDC | ~0 | ~2 s |
   | USDC on Base | ~999.80 USDC | ~0.02% | ~1 min |
   | USDT on Tron | ~999.50 USDT | ~0.05% | ~2 min |
   Values are labelled **estimated**. The amount owed is fixed in USDC; the recipient chooses only how to receive it.
5. **Confirm.** The backend fetches a real quote (if cross-chain), shows the exact minimum received and the deadline, and asks the recipient to sign the claim message. The message includes the payout target.
6. **Relayer submits.** The contract verifies the signature and Merkle proof, marks the leaf claimed, and transfers USDC to the payout target.
7. **Track.** The page shows status: `Submitted → Delivered` (or `Refunded → Retry`). The recipient gets a receipt.

## Flow C — Auditor / finance

1. Open `/runs/<run_key>/report` (approver or auditor session).
2. See the report: CSV hash, table hash, Merkle root, rule results, overrides, AI signature, and the on-chain transaction that anchored the report hash.
3. Press **Verify**: the browser recomputes the report hash, checks it against the contract, and verifies the NEAR AI Cloud signature.
4. Download the **reconciled export** (CSV/JSON): one row per recipient with status `claimed | unclaimed | refunded | reopened`, payout rail, destination, claim tx hash, 1Click deposit address and final status.

## Edge cases

| Situation | Behaviour |
|---|---|
| Recipient never claims | After the deadline an approver presses **Reclaim unclaimed funds** on the run page (the contract lets anyone call `reclaim_unclaimed`); the remainder goes to the run's refund account |
| Wrong address in the CSV | The recipient can't claim. They contact the team; approvers create a correction run (a new run with the fixed row). Never edit an active run's root |
| Duplicate rows | Flagged as `error` before the run can be created |
| Amount far above history or cap | `warning`; needs an override reason |
| Quote expired before submit | Fetch a new quote and ask for a new signature |
| 1Click returns `REFUNDED` / `FAILED` | Funds return to the contract (refund target). An approver calls `reopen_claim`; the recipient claims again |
| `INCOMPLETE_DEPOSIT` | Treat as failed; investigate; do not auto-retry |
| Overfunding | The contract returns the excess in `ft_on_transfer` |
| Run cancelled before funding | An approver presses **Cancel run** (`cancel_run`); nothing to refund |
| Recipient's wallet compromised | Out of scope; recommend fresh payout wallets |
