# 08 — Privacy model

A developer reviewing this idea warned: *keeping the salary table off-chain doesn't necessarily hide individual payouts.* That is correct. This file states exactly what Blindroll protects so the product, README and pitch never overclaim.

## Privacy levels

| Level | What's private | Needs | MVP? |
|---|---|---|---|
| **1. Data privacy** | CSV, AI processing, full table never published, per-recipient views | Nothing special | **Yes (core)** |
| **2. Unlinked payouts** | Payout doesn't arrive directly from the DAO's contract | Confidential Intents (shield → unshield) | Optional |
| **3. Private payouts** | Amount and payee hidden from the public chain | Confidential Intents, recipient keeps a confidential balance | Optional |

## What is visible on-chain (public NEAR USDC rail and 1Click rail)

| Item | Visible? | Where |
|---|---|---|
| Run exists, approvers, threshold, deadline | Yes | Contract state and events |
| Total funded amount | Yes | Funding `ft_transfer_call` |
| Merkle root, report hash | Yes | Contract state |
| Full salary table | **No** | Never published |
| Unclaimed rows | **No** | Never published |
| A claim's leaf data (address, amount) | **Yes, once claimed** | Claim transaction arguments |
| Contract → recipient (or 1Click deposit address) transfer and amount | **Yes** | USDC token contract |
| Delivery on the destination chain | **Yes** | Destination chain explorer |
| Names, emails, roles, memos | **No** | Off-chain only |
| AI prompts and responses | **No** | Only hashes and the signature are in the report |

Consequence: **after everyone claims, an observer can rebuild most of the amounts and addresses.** What they can't see: unclaimed rows, identities, memos, and the table before claims.

## Allowed claims (use this wording)

- ✅ "No public salary table."
- ✅ "Payroll data is processed privately; only a Merkle root and a report hash go on-chain."
- ✅ "Each contributor sees only their own row."
- ✅ "Payouts are standard on-chain transfers; private payouts via Confidential Intents are optional." (Only say "available" once it works.)
- ❌ "Invisible payments", "fully private payroll", "anonymous payouts", "no one can see salaries".

## Trust assumptions (MVP)

| Party | Sees plaintext? | Notes |
|---|---|---|
| Blindroll backend | **Yes** | It stores the table (encrypted at rest) and serves per-recipient rows. Must be stated in the README. Future work: run it in a TEE |
| NEAR AI Cloud model TEE | Yes (inside the TEE) | Verified with attestation and response signatures |
| Approvers | Yes | They review the table |
| Recipients | Only their own row | |
| Public | Only on-chain items above | |
| 1Click / solvers | Payout amount and destination | Inherent to cross-chain delivery |
| Confidential shard operators | Confidential transfers | Per near-supply-mcp's README: "hidden from the public, not from everyone" |

## Known leaks and mitigations

| Leak | Mitigation |
|---|---|
| Claim reveals leaf | Inherent to public claims. Use the confidential rail if available |
| Timing and amount correlation (even with confidential rails) | Document it. Don't claim anonymity |
| Wallet history exposure | Recommend a fresh payout wallet in the claim UI |
| Following one DAO across runs | Optional: new contract subaccount per organization |
| Membership probing ("is address X in this run?") | The backend only answers after a valid signature from that address |

## Confidential Intents (optional rail)

From the official docs (see [14-resources.md](14-resources.md)):
- Runs on **FAR**, a permissioned private NEAR fork (`intents.far`). Balances and swaps there are hidden from public indexers.
- **Shield** (public Intents → confidential) and **unshield** (confidential → public) are visible on the public chain.
- The 1Click quote API accepts `depositType` / `recipientType` / `refundType` = `CONFIDENTIAL_INTENTS`, and an optional `confidentiality` field (`public` default, `basic`, `advanced`).
- Reading a user's confidential balance needs a **User-Session token** (`POST /v0/auth/authenticate` with a wallet-signed empty intent).
- Private relay access for solvers is granted by the Defuse team. App access may be at NEAR Intents' discretion.

Rule: **timebox Confidential Intents to one day.** If a real shield + confidential transfer works with small amounts, add it as the "Keep it private" payout option. Otherwise list it as future work.
