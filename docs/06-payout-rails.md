# 06 — Payout rails

A **rail** delivers a claimed payout. The contract always ends a claim with an `ft_transfer` of USDC to one NEAR account (the payout target). Rails decide what that target is and what happens next.

## Interface (`packages/core/src/rails/types.ts`)

```ts
export type RailId = 'near-usdc' | 'oneclick' | 'confidential';

export interface PayoutOption {
  rail: RailId;
  label: string;                 // "USDC on Base"
  destinationAsset: string;      // 1Click assetId, or "nep141:<usdc>" for near-usdc
  destinationChain: string;      // "near" | "base" | "tron" | ...
  estimatedAmountOut: string;    // human-readable, labelled "estimated"
  feeBps?: number;
  etaSeconds?: number;
  simulated: boolean;
}

export interface PreparedPayout {
  rail: RailId;
  payoutKind: 'near_ft' | 'oneclick';
  payoutTarget: string;          // NEAR account the contract will ft_transfer to
  quoteRef?: string;             // 1Click depositAddress
  minAmountOut?: string;
  quoteDeadline?: string;
  destination: { asset: string; address: string };
  simulated: boolean;
}

export interface PayoutRail {
  id: RailId;
  options(input: { amount: bigint; recipientChain: string }): Promise<PayoutOption[]>;
  prepare(input: { amount: bigint; option: PayoutOption; destinationAddress: string }): Promise<PreparedPayout>;
  status(prepared: PreparedPayout, claimTx: string): Promise<'pending' | 'delivered' | 'refunded' | 'failed'>;
}
```

## Rail 1 — `near-usdc` (MVP, real on testnet)

- For NEAR and EVM recipients: `payoutTarget` = a NEAR account they enter (NEAR recipients default to their own account). It is in the signed message (EVM) or in the call they send themselves (NEAR). The backend refuses an account that does not exist, the contract account and the token account.
- Delivered as soon as the claim transaction succeeds.
- Testnet: mock USDC (6 decimals) deployed by us. Mainnet: native USDC. Confirm the token contract ID from Circle's or NEAR's docs before use (see [14](14-resources.md)).

## Rail 2 — `oneclick` (MVP: real dry quotes; execution real on mainnet only)

NEAR Intents 1Click API. **There is no testnet version of NEAR Intents.**

- Base URL: `https://1click.chaindefuser.com/v0`
- Auth: partner JWT from https://partners.near-intents.org, header `X-API-Key: <JWT>` (or `Authorization: Bearer <JWT>`). Without it, quotes carry an extra 0.25% fee.

| Method | Path | Use |
|---|---|---|
| GET | `/v0/tokens` | Supported assets: `assetId`, `blockchain`, `decimals`, `symbol`, `price`, `contractAddress` |
| POST | `/v0/quote` | Quote (`dry: true` for estimates) |
| POST | `/v0/deposit/submit` | `{depositAddress, txHash}` after our claim tx (optional, speeds things up) |
| GET | `/v0/status?depositAddress=…` | `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED` |

Asset ID formats: `nep141:<contract>` for NEAR tokens; `nep141:<chain>-<address>.omft.near` for bridged tokens. **Always read real IDs from `/v0/tokens`; never hard-code guesses.**

### Quote for a claim

```json
{
  "dry": false,
  "swapType": "EXACT_INPUT",
  "slippageTolerance": 50,
  "originAsset": "nep141:<USDC on NEAR>",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "<assetId from /v0/tokens>",
  "amount": "<leaf amount in base units>",
  "recipient": "<recipient's destination address>",
  "recipientType": "DESTINATION_CHAIN",
  "refundTo": "<blindroll contract id>",
  "refundType": "ORIGIN_CHAIN",
  "deadline": "<now + 10 min, ISO>"
}
```

- The response includes `depositAddress` (a NEAR account) → this becomes `payoutTarget` and is included in the claim message the recipient signs.
- Show `minAmountOut` (or the equivalent field in the real response; check it) and the deadline before signing.
- Use `dry: true` with the same body for the options board. Cache for 30 s.
- Confirm the exact response schema with a real call and update `types.ts`; the docs page doesn't show a response example.
- After the claim tx: `POST /v0/deposit/submit` with the tx hash, then poll `/v0/status` until a terminal status.

### Confirmed with real calls (2026-11-11)

Fixtures: `packages/core/test-vectors/oneclick/` (`tokens.json`, two dry quotes), recorded by `pnpm oneclick:record`. Client: `packages/core/src/rails/oneclick.ts`.
- Auth header that works: `Authorization: Bearer <JWT>`. A successful quote returns **HTTP 201**.
- Quote response: `{ quote: { amountIn, amountOut, minAmountOut, amountInFormatted, amountOutFormatted, amountInUsd, amountOutUsd, minAmountIn, timeEstimate (seconds), refundFee, withdrawFee }, quoteRequest: {…echo…}, signature, timestamp, correlationId }`. Amounts are base-unit strings. A dry quote has **no** `depositAddress`.
- `/v0/tokens` entries: `assetId`, `blockchain`, `symbol`, `decimals`, `price`, `priceUpdatedAt`, `contractAddress`, `coingeckoId`. Chain names are short (`near`, `base`, `arb`, `eth`, `sol`, `tron`, …).
- **`refundTo` must be an account that exists on mainnet.** Otherwise the API answers HTTP 400 `{"message":"Internal server error"}`. So a testnet contract ID cannot be used: on testnet, dry quotes send `refundTo: "near"` as a stand-in (`ONECLICK_DRY_REFUND_STAND_IN`; nothing moves in a dry quote). On mainnet `refundTo` is the Blindroll contract.

### Destination rules
- EVM recipients: destination chain must be an EVM chain, and by default the destination address is the verified address. If a different address is entered, it's shown clearly and included in the signed message.
- Start with: USDC on NEAR, USDC on Base, USDC on Arbitrum, USDT on Tron (if listed), native SOL/BTC as a stretch.

### Testnet behaviour
- Options board: **real** dry quotes from mainnet 1Click (they don't move funds), labelled "estimated" with "Estimate from mainnet prices". Quoted for EVM recipients (the quote needs a destination address of the right kind); destinations: USDC on Base, USDC on Arbitrum (`ONECLICK_DESTINATIONS`).
- **Execution: simulated, approved by the owner on 2026-11-11** (with the condition that a simulated refund is a real transfer). Active only when `SIM_SINK_ACCOUNT_ID` and `SIM_SINK_PRIVATE_KEY` are set; without them the cross-chain options are shown but cannot be chosen.
  - The sim sink (`sim-sink.blindroll-dev.testnet`) stands where a 1Click deposit address would be. The recipient signs a real claim message with `payout: oneclick:<sim sink>` and `to: <1Click assetId>:<their EVM address>`; the relayer submits `claim_evm`; the contract really pays the test USDC to the sim sink. The backend marks the payout `delivered_simulated`. Nothing is delivered on the destination chain.
  - Only EVM recipients, destination = their own verified address.
  - **Refund → reopen.** An approver presses "Simulate a failed delivery and refund". The failure is simulated; the refund is **real**: the backend signs, as the sim sink, `ft_transfer(receiver_id = Blindroll contract, amount = the claimed amount)`. Only when that transaction has succeeded does the payout become `refunded_simulated` (with `refund_tx`), and only then does the backend hand out the `reopen_claim` call and the UI enable "Reopen claim". A payout can be refunded once. This keeps the contract's balance whole, so a reopened claim is never paid from other runs' funds.
  - Labelling: `simulated: true` on the option, the prepare/submit/status responses and the payout list; a "Simulated" badge on the option, the review step, the claimed state and the approver's claims list; a row in the README table.
  - Since 2026-11-12: each cross-chain option's note reads "Estimated from live mainnet quote — delivery simulated on testnet." ("USDC on NEAR" is listed first, pre-selected, and carries a "Real on testnet" badge.) The claim page (when cross-chain options or a simulated claim are shown) and the run page's claims list (when a simulated payout exists) show one banner (`CrossChainSimNotice` in `apps/web/app/components/notices.tsx`): *"1Click has no testnet. The quotes are real 1Click estimates at mainnet prices (a quote moves no funds). On a simulated claim the contract really pays the test USDC to a holding account, and nothing arrives on the destination chain. A refund test simulates the failure; the refund itself is a real transfer from the holding account back to the contract. Real delivery requires mainnet."* That wording was checked against the code: the quote is a dry quote, the claim pays the sim sink, the refund is the sim sink's `ft_transfer` to the contract.
  - Mainnet: `assertNetworkConfig` rejects any `SIM_SINK_ACCOUNT_ID` when `NEAR_NETWORK=mainnet` (and a non-test account anywhere), `simSinkSender()` returns null on mainnet, and the claim service refuses simulated options and refunds there.
  - Path to real (mainnet): request a non-dry quote, use its `depositAddress` as the payout target, submit the deposit, poll `/v0/status`; `REFUNDED` then comes from 1Click, not from a button. Not built.

### Refunds
`REFUNDED` / `FAILED`: USDC returns to the contract (`refundTo`). The approver UI shows the status and a **Reopen claim** button (`reopen_claim`). The recipient then claims again with a new quote. `INCOMPLETE_DEPOSIT` shouldn't happen (we send the exact amount); treat it as failed and investigate.

## Rail 3 — `confidential` (not built; see "Roadmap: confidential payout rail" below)

Only if a real test works. Docs: Confidential Intents page and 1Click quote fields.
- `depositType` / `recipientType` / `refundType` accept `CONFIDENTIAL_INTENTS`; the optional `confidentiality` field accepts `public` (default), `basic`, `advanced`.
- A user's confidential balance is read with a User-Session token: the wallet signs an empty intent → `POST /v0/auth/authenticate` → `accessToken`, `refreshToken`; then `GET /v0/account/balances`, refresh via `POST /v0/auth/refresh`.
- Working reference: `near-supply-mcp/payment-mcp/src/rails/confidential.ts` (pays confidential-to-confidential USDC via 1Click on mainnet).
- Shield and unshield are visible publicly. Recipients who want the "Keep it private" option need an Intents account (the docs show NEAR accounts; confirm whether EVM keys work).

Test plan (mainnet, ~$2): shield 1 USDC → confidential transfer 0.50 USDC to a second account → check NearBlocks and the Intents explorer for what is visible → write the findings into [08](08-privacy-model.md).

## Roadmap: confidential payout rail

**Not built** (owner decision 2026-11-12: docs only). Checked against the live NEAR Intents docs on 2026-11-12 ([Confidential Intents](https://docs.near-intents.org/integration/market-makers/confidential-intents), [1Click making a request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md)).

**What leaks today.** Every claim ends with a public `ft_transfer` from the Blindroll contract. The claim transaction's arguments carry the leaf, so it reveals that one recipient's address and amount, and the transfer reveals the payout target (the recipient's NEAR account, or a 1Click deposit address, whose delivery is then visible on the destination chain).

**How a confidential rail would reduce that.** The payout would settle through NEAR Intents' confidential mode instead of a public transfer to the recipient:
- The live docs describe a private NEAR fork, **FAR**, where the `intents.far` contract keeps shielded balances; "balances and swap details on FAR are not visible to the public". `intents.near` on NEAR is the public ledger.
- The 1Click quote API accepts `CONFIDENTIAL_INTENTS` for `depositType`, `recipientType` and `refundType`, and an optional `confidentiality` field (`public` default, `basic`, `advanced`; the meaning of `basic` / `advanced` is described on a separate page: to be confirmed).
- A claim could then pay into the recipient's confidential Intents balance, so the destination and the delivered amount would not appear as a public transfer to the recipient.
- It **would reduce what a claim reveals; it would not make claims private.** Shield and unshield are public (tokens move to or from the Treasury account on NEAR), the operators of FAR see confidential transfers, and timing and amount correlation remain (see [08](08-privacy-model.md)). Whether the claim transaction's own arguments (the leaf) would still be public depends on the contract hook below: as designed today they would be, so the amount would still show in the claim call unless the leaf format changes. To be confirmed in a design pass.

**What is needed.**
1. **Access from the NEAR Intents (Defuse) team.** The docs say FAR is permissioned ("a small validator set with no public networking") and to "contact the Defuse team for access to the private relay URL and credentials". Whether an app (rather than a market maker) can get access: to be confirmed.
2. **Mainnet testing.** The docs mention no testnet for Confidential Intents (1Click has none either). The test plan above (shield 1 USDC → confidential transfer → check what NearBlocks and the Intents explorer show) has to run on mainnet with small amounts.
3. **A contract hook.** The contract must pay into the intents contract instead of a plain `ft_transfer` to the recipient: a new payout kind (e.g. `confidential`) that sends USDC with `ft_transfer_call` to `intents.near` (or to a 1Click deposit address from a quote with `recipientType: CONFIDENTIAL_INTENTS`), bound into the signed claim message like `oneclick` is today. The exact deposit method into `intents.near` for a third-party beneficiary is not described on the Confidential Intents page: to be confirmed. This is a contract change and a redeploy, so it needs the owner's approval.
4. **Recipient side.** The recipient needs an Intents account and a User-Session token to read a confidential balance (see Rail 3 above). Whether EVM keys work for that: to be confirmed.

