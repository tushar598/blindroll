"use client";
/**
 * Read-only contract calls made by the BROWSER, straight to public NEAR RPC endpoints, so a check
 * such as "does the contract hold this report hash" does not depend on trusting our server.
 */
const PUBLIC_RPC: Record<string, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

export interface ChainView<T> {
  value: T;
  /** The RPC endpoint that answered. */
  rpcUrl: string;
  blockHeight: number;
}

export async function viewContract<T>(network: string, contractId: string, method: string, args: object): Promise<ChainView<T>> {
  const urls = PUBLIC_RPC[network];
  if (!urls) throw new Error(`No public RPC endpoint for network "${network}"`);
  let lastError: unknown;
  for (const rpcUrl of urls) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "blindroll", method: "query",
          params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
        }),
      });
      const body = (await res.json()) as { result?: { result?: number[]; error?: string; block_height?: number }; error?: { message?: string; data?: unknown } };
      if (body.error) throw new Error(typeof body.error.data === "string" ? body.error.data : (body.error.message ?? "RPC error"));
      if (!body.result?.result) throw new Error(body.result?.error ?? "The RPC returned no result");
      const value = JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
      return { value, rpcUrl, blockHeight: body.result.block_height ?? 0 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The NEAR RPC could not be reached");
}
