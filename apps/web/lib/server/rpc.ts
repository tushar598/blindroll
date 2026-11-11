import { serverConfig } from "./config";

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(serverConfig().rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "blindroll", method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`NEAR RPC returned HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string; data?: unknown } };
  if (body.error) throw new RpcError(body.error.cause?.name ?? "RPC_ERROR", typeof body.error.data === "string" ? body.error.data : (body.error.message ?? "RPC error"));
  return body.result as T;
}

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** True when `publicKey` is a full-access key of `accountId` (NEP-413 sign-in requirement). */
export async function isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const r = await rpc<{ permission?: unknown; error?: string }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
    return r.permission === "FullAccess";
  } catch {
    return false;
  }
}

/** Calls a view method and parses its JSON result. */
export async function viewFunction<T>(contractId: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error || !r.result) throw new RpcError("VIEW_ERROR", r.error ?? "empty view result");
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

/** True when the account exists on-chain (so a payout cannot be sent to a typo). */
export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    return true;
  } catch (err) {
    if (err instanceof RpcError && err.code === "UNKNOWN_ACCOUNT") return false;
    throw err;
  }
}

/** Current nonce of an access key and a recent block hash, for building a transaction. */
export async function accessKeyNonce(accountId: string, publicKey: string): Promise<{ nonce: bigint; blockHash: string }> {
  const r = await rpc<{ nonce: number | string; block_hash: string }>("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  return { nonce: BigInt(r.nonce), blockHash: r.block_hash };
}

export interface TxOutcome {
  txHash: string;
  /** Null when every receipt succeeded; otherwise a short description of the first failure. */
  failure: string | null;
  logs: string[];
}

/** Sends a signed transaction and waits until it and its receipts have executed. */
export async function sendTransaction(signedBase64: string): Promise<TxOutcome> {
  const r = await rpc<{
    status?: { Failure?: unknown };
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
    receipts_outcome?: Array<{ outcome?: { logs?: string[]; status?: { Failure?: unknown } } }>;
  }>("send_tx", { signed_tx_base64: signedBase64, wait_until: "FINAL" });
  const receipts = r.receipts_outcome ?? [];
  const failed = r.status?.Failure ?? receipts.find((x) => x.outcome?.status?.Failure !== undefined)?.outcome?.status?.Failure;
  return {
    txHash: r.transaction?.hash ?? r.transaction_outcome?.id ?? "",
    failure: failed === undefined ? null : JSON.stringify(failed).slice(0, 400),
    logs: receipts.flatMap((x) => x.outcome?.logs ?? []),
  };
}
