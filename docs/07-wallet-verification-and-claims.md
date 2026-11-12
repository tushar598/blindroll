# 07 — Wallet verification and claims

Two signatures are involved:
1. **View signature** (off-chain): proves the recipient controls the address, so the backend can show their row.
2. **Claim signature** (verified on-chain for EVM): authorizes paying this leaf to this payout target.

## Supported wallets

| Chain | MVP | Libraries |
|---|---|---|
| EVM | ✅ | `wagmi` + `viem` (injected / WalletConnect) |
| NEAR | ✅ | `@near-wallet-selector/*` |
| Solana | Stretch | `@solana/wallet-adapter-*` |

As built (2026-11-11): EVM wallets are reached through injected providers found with EIP-6963 (`apps/web/lib/client/evm.ts`), with `viem` for verification on the server; `wagmi` and WalletConnect are not used. NEAR recipients use Meteor through wallet-selector.

## View message

```
Blindroll: view my payout
run: {run_key}
address: {address}
nonce: {nonce}
issued: {iso_timestamp}
```
- EVM: `personal_sign`; verify with `viem.verifyMessage`.
- NEAR: NEP-413 `signMessage` (`message` = text above, `recipient` = `"blindroll"`, 32-byte `nonce`). Verify the signature and that the public key belongs to the account (`view_access_key` RPC).
- Solana: `signMessage`; verify with `tweetnacl`.
- Nonces are single-use, valid for 5 minutes. `GET /api/claim/:runKey/challenge` returns `{nonce, issued, recipient}`; the nonce is 32 random bytes in base64 and is used both as the `nonce:` line and (decoded) as the NEP-413 nonce. `issued` must be within 5 minutes of the server clock.

## Claim message (EVM) — must match the contract byte for byte

```
Blindroll claim v1
contract: {contract_id}
run: {run_key}
leaf: {leaf_hash_hex}
payout: {payout_kind}:{payout_target}
to: {destination_asset}:{destination_address}
expires: {expires_at_ms}
```
- Lines joined with `\n`, no trailing newline. `payout_kind` ∈ `near_ft`, `oneclick`.
- `to` is informational (the contract can't check what 1Click will deliver), but it's in the signed record so the recipient approved it. `claim_evm` takes `destination_asset` and `destination_address` as arguments only to rebuild this line.
- For a `near_ft` payout, use `destination_asset` = `nep141:<USDC token account>` and `destination_address` = the receiver account.
- Field rules (same in TypeScript and Rust, see [04](04-smart-contract-spec.md) → "Input validation"): `run_key` is `[A-Za-z0-9_-]{1,64}`; `leaf_hash_hex` is 64 lowercase hex; `contract_id` and `payout_target` are NEAR account IDs; `destination_asset` and `destination_address` are 1–128 printable ASCII chars without `|`; `expires_at_ms` is a positive integer. No field can contain `\n`, `\r` or `|`, so a value can never forge another line.
- The signature passed to the contract is `0x` + 130 lowercase hex chars (`r || s || v`, `v` = 27/28 or 0/1). High-`s` signatures are rejected.
- Signing: `personal_sign` (EIP-191). Contract: `hash = keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`; split the 65-byte signature into `r||s` and `v` (27/28 → 0/1); `env::ecrecover(hash, rs, v, true)` → 64-byte public key → `address = "0x" + hex(keccak256(pubkey)[12..])`; compare to the leaf address.
- `expires_at_ms` = quote deadline or now + 10 min, whichever is earlier.
- Build the message in one function in `packages/core/src/claims/message.ts`, and test the Rust side against vectors generated from it (`packages/core/test-vectors/claim-message.json`, signed with the public Hardhat/Anvil test keys #0 and #1).

## NEAR recipients — meta-transactions (NEP-366)

- The frontend builds a `FunctionCall` action `claim_near(run_key, leaf, proof, payout)` and asks the wallet to sign a **delegate action** (signed but not sent). The backend's relayer wraps it in a transaction and pays gas. The contract sees `predecessor_account_id == recipient`.
- Wallet support for signing delegate actions varies. Check which wallets in wallet-selector support it. **Fallback:** the recipient calls `claim_near` directly and pays a tiny gas fee. Document this in the UI.
- The relayer account must have a **full-access key** to send Delegate actions (function-call keys can't), so use a dedicated account with a small balance and a monitored top-up.

**As built (2026-11-12): gas-free through `claim_near_relayed`, not through delegate actions.**

- *Spike result (1 hour, 2026-11-12).* Wallet Selector 10.1.4 cannot sign delegate actions for Meteor (its Meteor module bundles `@meteorwallet/sdk` 1.0.24, which has no delegate-action call). Meteor's own SDK 3.24.1 documents `near::sign_delegate_actions`, but it keeps its own connection (`MeteorConnect` storage), so the claim page would need a second Meteor sign-in next to Wallet Selector plus one more approval popup, and it adds about 2.5 MB of JavaScript. A real signature could not be obtained inside the timebox: Meteor's web wallet is behind bot protection, so it cannot be driven by a test browser, and only the owner's wallet could prove it. The owner's rule for that case was to build the fallback below.
- *What runs now.* A NEAR recipient who takes **USDC on NEAR to their own account** signs nothing after the view signature: `POST /api/claim/:runKey/submit {claimId}` makes the relayer call `claim_near_relayed(run_key, leaf, proof)` ([04](04-smart-contract-spec.md)), which pays only the leaf's account. The relayer pays the gas; the recipient needs no NEAR. The view signature (NEP-413, full-access key checked) is what proves to the backend that the caller controls that account; the contract does not depend on it, because the payout can go nowhere else.
- *Another receiver.* If the recipient types a different NEAR account, the old path is used: they call `claim_near` from their own wallet and pay the gas; the page reports the transaction and the backend confirms it with `is_claimed`.
- A prepared relayed claim is valid for 10 minutes and can be submitted once; a failed relay can be retried with a new prepare.

## EVM recipients — relayer submits

1. Recipient signs the claim message.
2. `POST /api/claim/:runKey/submit` → the relayer calls `claim_evm(run_key, leaf, proof, payout, destination_asset, destination_address, expires_at_ms, signature_hex)`. Gas attached: 100 TGas.
3. The relayer can't change the payout target: the contract rebuilds the message from the arguments and verifies the signature.

The relayer (`apps/web/lib/server/relayer.ts` + `near-tx.ts`) builds, signs and sends the transaction itself (borsh `FunctionCall`, ed25519, `send_tx` with `wait_until: FINAL`), one at a time so nonces never collide. `pnpm relayer:check` sends one harmless real transaction to prove the key works. After sending, the backend trusts only the contract: the claim is `confirmed` when `is_claimed` is true, otherwise `failed` (a failed token transfer is rolled back on-chain and can be retried).

## Relayer safeguards

- Rate-limit submissions per IP and per run.
- Simulate (view-call checks) before sending: run Active, leaf not claimed, proof valid.
- Keep a low balance; alert below a threshold.
- Log every submitted transaction to `audit_log`.

## Claim page states

`Connect wallet` → `Sign to view` → `Not listed` | `Your payout` → `Choose payout` → `Review quote` → `Sign claim` → `Submitted` → `Delivered` | `Refunded (team notified)` | `Deadline passed`.
