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
