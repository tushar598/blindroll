# 08 — Privacy model

A developer reviewing this idea warned: *keeping the salary table off-chain doesn't necessarily hide individual payouts.* That is correct. This file states exactly what Blindroll protects so the product, README and pitch never overclaim.

## First: the Blindroll backend sees plaintext

**The Blindroll server can read the full payroll table.** It parses the uploaded CSV, so it holds the plaintext; it stores the table encrypted at rest (AES-256-GCM) and shows a recipient only their own row, after a valid wallet signature. On-chain, only the Merkle root and the report hash are public; a claim reveals that one recipient's address and amount. Future work: run the backend in a TEE.

This line comes first in the README privacy section and in the trust notice on the claim page and the run page (`apps/web/app/components/notices.tsx`). Keep it first.

## Trust assumptions (MVP)

| Party | Sees plaintext? | Notes |
|---|---|---|
| Blindroll backend | **Yes** | It stores the table (encrypted at rest) and serves per-recipient rows. Must be stated in the README. Future work: run it in a TEE |
| NEAR AI Cloud model TEE | Header + up to 5 sample rows, emails masked (inside the TEE) | Response signature verified. Attestation checked offline for consistency only; the Intel TDX quote signature and NVIDIA GPU evidence are **not** verified ([05](05-ai-pipeline-and-attestation.md#attestation-checks-2026-11-12)) |
| Approvers | Yes | They review the table |
| Recipients | Only their own row | |
| Public | Only the on-chain items below | |
| 1Click / solvers | Payout amount and destination | Inherent to cross-chain delivery |
| Confidential shard operators | Confidential transfers | Per near-supply-mcp's README: "hidden from the public, not from everyone" |

### Why not client-side decryption (yet)

Encrypting each row to its recipient so that only their wallet can decrypt it would not remove the main trust assumption, and the wallets do not support it well:
- **The server parses the CSV**, so it already holds the plaintext. Encrypting rows to recipients after that point hides nothing from the server.
- **MetaMask's `eth_decrypt` / `eth_getEncryptionPublicKey` are deprecated**, so there is no maintained way to decrypt to an EVM wallet.
- **NEAR wallets have no standard encryption API** (NEP-413 covers signing messages, not decryption).

The real fix is to run the backend itself in a TEE (for example a NEAR AI Cloud or Phala-style confidential VM) and publish its attestation, so that "the server sees plaintext" becomes "attested code sees plaintext". Listed as future work; not built.

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
- ✅ "Each contributor sees only their own row." (Add, where space allows: "The Blindroll server can read the full table.")
- ✅ "A confidential payout rail would reduce what a claim reveals." (Roadmap only; never "makes claims private".)
- ✅ "Payouts are standard on-chain transfers; private payouts via Confidential Intents are optional." (Only say "available" once it works.)
- ❌ "Invisible payments", "fully private payroll", "anonymous payouts", "no one can see salaries", "trustless privacy", "without ever seeing anyone else's data" (the server does), "no trust in the approver" (approvers see the table).

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
- The 1Click quote API accepts (re-checked against the live docs on 2026-11-12) `depositType` / `recipientType` / `refundType` = `CONFIDENTIAL_INTENTS`, and an optional `confidentiality` field (`public` default, `basic`, `advanced`).
- Reading a user's confidential balance needs a **User-Session token** (`POST /v0/auth/authenticate` with a wallet-signed empty intent).
- Private relay access for solvers is granted by the Defuse team. App access may be at NEAR Intents' discretion.

Status (2026-11-12): **not built; roadmap only.** No testnet exists for it, and access needs the NEAR Intents (Defuse) team. What it would change and what it needs: [06 → "Roadmap: confidential payout rail"](06-payout-rails.md#roadmap-confidential-payout-rail). It would reduce what a claim reveals; it would not hide timing, and shield/unshield stay public.
