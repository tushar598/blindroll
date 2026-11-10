# Blindroll docs

Blindroll is claim-based payroll for DAOs and crypto-native teams, built on NEAR for the NEAR Hackathon (tracks: **Real-World Money** + **Privacy & Private AI**).

> Contributors verify their own wallet, claim in any asset on any chain without gas, every payroll run is checked by private AI and attested, and the salary table is never published.

These docs are the source of truth for whoever builds the product, human or AI. Read them in order before writing code.

## Reading order

| # | File | What it covers |
|---|---|---|
| 01 | [01-product-overview.md](01-product-overview.md) | Concept, problem, users, USP, positioning, non-goals |
| 02 | [02-user-flows.md](02-user-flows.md) | Approver, recipient and auditor flows, edge cases |
| 03 | [03-architecture.md](03-architecture.md) | Components, data flow, trust boundaries |
| 04 | [04-smart-contract-spec.md](04-smart-contract-spec.md) | Contract state, methods, events, Merkle format, invariants |
| 05 | [05-ai-pipeline-and-attestation.md](05-ai-pipeline-and-attestation.md) | CSV intake, anomaly rules, NEAR AI Cloud, attested report |
| 06 | [06-payout-rails.md](06-payout-rails.md) | Rail interface, NEAR USDC rail, 1Click rail, confidential rail, refunds |
| 07 | [07-wallet-verification-and-claims.md](07-wallet-verification-and-claims.md) | Signature schemes, claim messages, relayer, meta-transactions |
| 08 | [08-privacy-model.md](08-privacy-model.md) | What is private, what is visible on-chain, allowed claims |
| 09 | [09-api-and-data-model.md](09-api-and-data-model.md) | Backend API endpoints and database schema |
| 10 | [10-tech-stack-and-repo.md](10-tech-stack-and-repo.md) | Stack, repo layout, environment variables, conventions |
| 11 | [11-security-threat-model.md](11-security-threat-model.md) | Threats and mitigations |
| 12 | [12-build-plan.md](12-build-plan.md) | MVP scope, cut list, day-by-day plan |
| 13 | [13-testing-and-demo.md](13-testing-and-demo.md) | Test plan, demo script, "do X → see Y", real vs simulated |
| 14 | [14-resources.md](14-resources.md) | All external docs, APIs and reference repos |
| 15 | [15-competitive-landscape.md](15-competitive-landscape.md) | Similar projects and how Blindroll differs |
| — | [samples/](samples/) | Example messy and clean payroll CSVs |

## Key decisions (do not change without updating these docs)

1. **Claim-based (pull) payroll.** Funds are locked in a contract; each recipient claims their own payout. No push payments to addresses nobody verified.
2. **Only a Merkle root goes on-chain.** The salary table is never published. Each claim reveals only that claimant's leaf.
3. **The AI proposes, code decides.** The LLM maps messy columns and explains findings. Deterministic code applies the mapping and runs the anomaly rules. The AI never moves money.
4. **Every run has an attested report.** Its hash is stored on-chain when the run is created.
5. **Payout is a pluggable rail.** The public NEAR USDC rail and the 1Click rail are the MVP. Confidential Intents is an optional rail, added only if access works.
6. **Honest privacy.** We say "no public salary table", never "invisible payments". See [08-privacy-model.md](08-privacy-model.md).
7. **Label everything simulated.** Anything not real in the demo is marked `simulated` in the UI, API responses and README.

## Glossary

| Term | Meaning |
|---|---|
| **Run** | One payroll batch: a CSV, its report, its Merkle root, its funding and its claims |
| **Approver** | A NEAR account allowed to review and approve a run (can be a multisig/DAO account) |
| **Recipient** | A contributor listed in a run who claims a payout |
| **Leaf** | One recipient row hashed into the Merkle tree |
| **Rail** | A way to deliver a payout (NEAR USDC, 1Click cross-chain, confidential) |
| **Attested report** | JSON describing the checks on a run, including the NEAR AI Cloud signature, hashed and anchored on-chain |
| **Relayer** | Backend NEAR account that submits claim transactions and pays gas |
| **1Click** | NEAR Intents API that turns a deposit into delivery of another asset on another chain |
