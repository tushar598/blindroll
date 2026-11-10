# 01 — Product overview

## One-liner

**Blindroll** lets a DAO or crypto-native team run payroll from one NEAR treasury. Contributors verify their own wallet and claim in the asset and chain they choose, without needing NEAR for gas. Private AI checks every run before money moves, and an attested report proves it. The salary table is never published.

## Problem

Teams paying 10–100 global contributors on-chain face five problems:

1. **Public salary tables.** On a public chain anyone can see who was paid what, which causes internal conflict and makes contributors targets.
2. **Messy payroll files.** Wrong columns, mixed currencies (`$800`, `1,200.50 USDC`), duplicate rows. One mistake sends money irreversibly.
3. **Wrong-address payments.** Typos and address poisoning send funds to the wrong place.
4. **Every contributor wants something different.** USDC on Base, USDT on Tron, SOL, BTC. Treasurers pay wallet by wallet, by hand.
5. **No proof that checks happened.** "We reviewed it" or "the AI checked it" is just trust. Auditors and token holders get nothing verifiable.

## Solution

1. Approvers sign in with a NEAR wallet (can be a multisig) and upload the payroll CSV.
2. Private AI (NEAR AI Cloud, running in a TEE) maps messy columns and normalizes currencies. Deterministic rules flag duplicates, outliers, invalid addresses and budget overruns.
3. An **attested report** is generated: it binds the CSV hash, the normalized table hash, the Merkle root, the rule results and the NEAR AI Cloud response signature.
4. Approvers review the table and flags, then sign the run on-chain (M-of-N).
5. The team funds the run with USDC. The contract stores only the Merkle root and the report hash.
6. Each recipient opens the claim page, connects their wallet and signs. They see only their own row, compare live estimates for each payout option, and claim. The relayer pays gas.
7. The payout is delivered through a rail: USDC on NEAR, or any supported asset/chain through NEAR Intents (1Click).
8. Failed payouts are refunded to the contract and can be reopened. After the claim deadline, unclaimed funds go back to the treasury.
9. Finance downloads a reconciled export: claimed, unclaimed, refunded, with transaction hashes.

## Users

| User | Goal | What they do in Blindroll |
|---|---|---|
| **Approver / community operator** | Pay everyone correctly and safely | Upload CSV, review flags, approve, fund, export |
| **Recipient / contributor** | Get paid in their preferred asset and chain, safely | Connect wallet, view own row, choose payout, claim |
| **Auditor / finance** | Reconcile and verify | Read the report, verify attestation, download export |

**Primary market:** DAOs, crypto-native startups and remote teams that already pay contributors in crypto.

## USP (what makes Blindroll different)

1. **Self-verified, claim-based payouts.** Only the wallet listed in the run can claim, by signing. No push payments to unverified addresses.
2. **Any asset, any chain, no gas.** NEAR Intents delivers the recipient's choice; the relayer pays gas.
3. **Attested pre-payment checks.** A verifiable record that the AI cleanup and anomaly rules ran on this exact file before money moved.
4. **No public salary table.** Only a Merkle root goes on-chain; each person sees only their own row.

## Payment types and privacy setting

Privacy is a per-run setting, not the whole product:

| Run type | Typical use | Setting |
|---|---|---|
| **Public** | Bounties and grants the DAO announces anyway | Table may be exported publicly by the DAO |
| **Private** (default) | Salaries, contractor rates | Table never published; per-recipient views only |

Even when amounts are public, the strongest privacy argument is **wallet protection**: an announcement says "Alice won $1,000"; an on-chain payment exposes Alice's wallet, balance and history. Recommend that recipients use a fresh payout wallet.

## Why NEAR

| NEAR feature | Use in Blindroll |
|---|---|
| USDC on NEAR, low fees, ~1–2 s finality | Cheap, fast funding and claims |
| NEAR AI Cloud (TEE + signed responses) | Private AI processing with verifiable signatures |
| NEAR Intents / 1Click API | Delivery in the recipient's chosen asset and chain |
| Meta-transactions (NEP-366) and a relayer | Recipients never need NEAR |
| `env::ecrecover`, `env::ed25519_verify` in contracts | The contract verifies EVM/Solana claim signatures on-chain |
| Named accounts, function-call keys, multisig accounts | Readable roles and scoped permissions |

## Non-goals (MVP)

- Fiat on/off-ramps, KYC/AML, tax forms, payslips.
- Streaming payments or vesting.
- Hiding amounts from destination chains (impossible on public chains).
- Running the whole backend inside a TEE (only AI inference runs in a TEE in the MVP).
- Supporting every chain for wallet verification (MVP: NEAR + EVM; Solana is a stretch goal).

## Pitch (short)

> **Problem:** DAOs paying global contributors face public salary tables, messy CSVs, wrong-address payments and contributors who each want a different asset on a different chain, with no proof that anyone checked the payroll.
>
> **Solution:** Blindroll. Upload the CSV, private AI cleans it and flags anomalies, an attested report proves the checks ran, approvers sign and fund once, and each contributor verifies their own wallet and claims in their chosen asset and chain, gas-free.
>
> **Tech:** NEAR AI Cloud (TEE) for private processing and signed results, a NEAR contract holding USDC with only a Merkle root and the report hash, on-chain EVM signature checks, NEAR Intents (1Click) for cross-chain delivery, and a relayer so recipients never need NEAR.
