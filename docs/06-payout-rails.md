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

- For NEAR recipients only: `payoutTarget` = their NEAR account (or another NEAR account they enter, which is in the signed message).
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

### Destination rules
- EVM recipients: destination chain must be an EVM chain, and by default the destination address is the verified address. If a different address is entered, it's shown clearly and included in the signed message.
- Start with: USDC on NEAR, USDC on Base, USDC on Arbitrum, USDT on Tron (if listed), native SOL/BTC as a stretch.

### Testnet behaviour
- Options board: **real** dry quotes from mainnet 1Click (they don't move funds), labelled "estimate from mainnet prices".
- Execution: **simulated**. The contract pays a `sim-sink.<contract>` account and the backend marks the payout `delivered (simulated)`. Every UI and API response says `simulated: true`.

### Refunds
`REFUNDED` / `FAILED`: USDC returns to the contract (`refundTo`). The approver UI shows the status and a **Reopen claim** button (`reopen_claim`). The recipient then claims again with a new quote. `INCOMPLETE_DEPOSIT` shouldn't happen (we send the exact amount); treat it as failed and investigate.

## Rail 3 — `confidential` (optional, timeboxed to 1 day)

Only if a real test works. Docs: Confidential Intents page and 1Click quote fields.
- `depositType` / `recipientType` / `refundType` accept `CONFIDENTIAL_INTENTS`; the optional `confidentiality` field accepts `public` (default), `basic`, `advanced`.
- A user's confidential balance is read with a User-Session token: the wallet signs an empty intent → `POST /v0/auth/authenticate` → `accessToken`, `refreshToken`; then `GET /v0/account/balances`, refresh via `POST /v0/auth/refresh`.
- Working reference: `near-supply-mcp/payment-mcp/src/rails/confidential.ts` (pays confidential-to-confidential USDC via 1Click on mainnet).
- Shield and unshield are visible publicly. Recipients who want the "Keep it private" option need an Intents account (the docs show NEAR accounts; confirm whether EVM keys work).

Test plan (mainnet, ~$2): shield 1 USDC → confidential transfer 0.50 USDC to a second account → check NearBlocks and the Intents explorer for what is visible → write the findings into [08](08-privacy-model.md).
