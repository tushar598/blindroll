# 15 — Competitive landscape

## Hackathon projects reviewed (same tracks)

Based on their READMEs, not their code.

| Project | What it does | Overlap |
|---|---|---|
| near-supply-mcp | AI assistant pays human-approved supplier POs in USDC, privately via Confidential Intents on mainnet | High on the confidential payout rail (B2B suppliers, not payroll) |
| privatepay-agent | Agent pays invoices; TEE reads redacted invoices; contract enforces caps, whitelist, duplicate refusal | High on TEE AI + safety; mentions "invoice and payroll workflow" |
| aftercall | Private meeting notes that pay contractors in USDC under caps; autopilot | Medium-high on contractor payouts |
| penstock | Agents pay any API from any chain via Intents; seller receives USDC on NEAR with CSV export | Medium (receiving side) |
| veridom-pay | Construction milestone escrow; TEE AI inspects photos | Low-medium |
| jurat | Proves a confidential balance ≥ X | Complementary |
| tee-receipts | Anchors NEAR AI signatures on-chain | Building block |
| omniyield-protocol | DeFi vaults; gasless relayer | Low |
| intents-desk | 1Click reliability monitor | None (useful risk data) |
| aurea, morrowseal, deaddrop, redline | Medical records, inheritance vault, file sales, bug bounties | None |

## Outside the hackathon

Crypto payroll tools exist (for example Request Finance, Parcel, Utopia, Deel's crypto option). Their current features weren't verified for these docs, so never claim "nothing like this exists".

## Blindroll's position

What none of the reviewed projects combine:
1. **Bulk payroll run from a messy CSV** with AI mapping and deterministic rules.
2. **Claim-based payouts** where each recipient self-verifies and sees only their own row.
3. **Per-recipient asset/chain choice** via 1Click, gas-free.
4. **Attested pre-payment report** anchored on-chain and verifiable in the browser.

Claim to use: *"On NEAR, we didn't find another project combining claim-based payroll, per-recipient asset choice and attested pre-payment checks."*
