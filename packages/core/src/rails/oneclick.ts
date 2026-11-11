import { z } from "zod";
import { ValidationError } from "../validate.ts";

/** 1Click API (NEAR Intents). Field names confirmed against real responses: test-vectors/oneclick/. */

export const OneClickTokenSchema = z.object({
  assetId: z.string().min(1).max(200),
  blockchain: z.string().min(1).max(40),
  symbol: z.string().min(1).max(40),
  decimals: z.number().int().min(0).max(36),
  price: z.number().optional(),
  contractAddress: z.string().optional(),
});
export type OneClickToken = z.infer<typeof OneClickTokenSchema>;

const baseUnits = z.string().regex(/^\d+$/);

/** Response of POST /v0/quote. A dry quote has no depositAddress. */
export const OneClickQuoteResponseSchema = z.object({
  quote: z.object({
    amountIn: baseUnits,
    amountOut: baseUnits,
    minAmountOut: baseUnits,
    amountOutFormatted: z.string().optional(),
    timeEstimate: z.number().optional(),
    depositAddress: z.string().optional(),
    deadline: z.string().optional(),
  }),
});

export interface OneClickQuote {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  timeEstimateSeconds?: number;
  /** Only on a real (non-dry) quote. */
  depositAddress?: string;
}

export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
}

export const ONECLICK_SLIPPAGE_BPS = 50;

/** docs/06 "Quote for a claim". `refundTo` must be an account that exists on the 1Click network (mainnet). */
export function buildQuoteRequest(input: {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  recipient: string;
  refundTo: string;
  deadline: Date;
}): OneClickQuoteRequest {
  if (input.amount <= 0n) throw new ValidationError("quote amount must be positive");
  return {
    dry: input.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: ONECLICK_SLIPPAGE_BPS,
    originAsset: input.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destinationAsset,
    amount: input.amount.toString(),
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: input.deadline.toISOString(),
  };
}

export function parseQuoteResponse(json: unknown): OneClickQuote {
  const r = OneClickQuoteResponseSchema.safeParse(json);
  if (!r.success) throw new ValidationError("1Click quote response has an unexpected shape");
  const q = r.data.quote;
  return {
    amountIn: BigInt(q.amountIn),
    amountOut: BigInt(q.amountOut),
    minAmountOut: BigInt(q.minAmountOut),
    ...(q.timeEstimate !== undefined ? { timeEstimateSeconds: q.timeEstimate } : {}),
    ...(q.depositAddress !== undefined ? { depositAddress: q.depositAddress } : {}),
  };
}

export function parseTokens(json: unknown): OneClickToken[] {
  const r = z.array(OneClickTokenSchema).safeParse(json);
  if (!r.success) throw new ValidationError("1Click token list has an unexpected shape");
  return r.data;
}

/** Asset IDs always come from the live token list, never from a hard-coded guess (docs/06). */
export function findToken(tokens: readonly OneClickToken[], blockchain: string, symbol: string): OneClickToken | undefined {
  return tokens.find((t) => t.blockchain === blockchain && t.symbol === symbol);
}

/** Cost of the route in basis points, for two assets with the same decimals (stablecoin to stablecoin). */
export function feeBps(amountIn: bigint, amountOut: bigint): number {
  if (amountIn <= 0n || amountOut >= amountIn) return 0;
  return Number(((amountIn - amountOut) * 10000n) / amountIn);
}

export type OneClickFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export interface OneClickConfig {
  baseUrl: string;
  /** Partner JWT; never logged. */
  jwt: string;
  fetch: OneClickFetch;
}

export async function fetchTokens(cfg: Pick<OneClickConfig, "baseUrl" | "fetch">): Promise<OneClickToken[]> {
  const res = await cfg.fetch(`${cfg.baseUrl.replace(/\/$/, "")}/tokens`);
  if (!res.ok) throw new ValidationError(`1Click /tokens returned HTTP ${res.status}`);
  return parseTokens(JSON.parse(await res.text()));
}

export async function fetchQuote(cfg: OneClickConfig, request: OneClickQuoteRequest): Promise<OneClickQuote> {
  const res = await cfg.fetch(`${cfg.baseUrl.replace(/\/$/, "")}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.jwt}` },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  if (!res.ok) throw new ValidationError(`1Click /quote returned HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError("1Click /quote did not return JSON");
  }
  return parseQuoteResponse(json);
}
