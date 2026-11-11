import { serverConfig } from "./config";
import { parseRelayerKey, signTransaction } from "./near-tx";
import { type TxOutcome, accessKeyNonce, sendTransaction } from "./rpc";

export interface FunctionCall {
  receiverId: string;
  methodName: string;
  args: object;
  gasTgas: number;
  /** yoctoNEAR; "1" for NEP-141 transfers. Defaults to 0. */
  depositYocto?: string;
}
export type RelayFn = (call: FunctionCall) => Promise<TxOutcome>;

// One transaction at a time per signer, so two calls never reuse the same access-key nonce.
const queues = new Map<string, Promise<unknown>>();

function sender(signerId: () => string, privateKey: () => string): RelayFn {
  return (call) => {
    const run = async () => {
      const key = parseRelayerKey(privateKey());
      const { nonce, blockHash } = await accessKeyNonce(signerId(), key.publicKey);
      const { signedBase64 } = signTransaction(
        {
          signerId: signerId(),
          receiverId: call.receiverId,
          nonce: nonce + 1n,
          blockHash,
          methodName: call.methodName,
          args: call.args,
          gas: BigInt(call.gasTgas) * 1_000_000_000_000n,
          deposit: BigInt(call.depositYocto ?? "0"),
        },
        key,
      );
      return sendTransaction(signedBase64);
    };
    const id = signerId();
    const prev = queues.get(id) ?? Promise.resolve();
    const result = prev.then(run, run);
    queues.set(id, result.catch(() => undefined));
    return result;
  };
}

/** Sends one function call from the relayer account, which pays the gas. Keys never leave this module. */
export const relay: RelayFn = sender(
  () => serverConfig().relayerAccountId,
  () => process.env.RELAYER_PRIVATE_KEY ?? "",
);

/**
 * TESTNET ONLY. Sends a call signed by the sim sink (the stand-in for a 1Click deposit address).
 * Null when it is not configured; serverConfig() already refuses a sim sink on mainnet.
 */
export function simSinkSender(): RelayFn | null {
  const config = serverConfig();
  if (config.network === "mainnet" || !config.simSinkAccountId || !process.env.SIM_SINK_PRIVATE_KEY) return null;
  return sender(
    () => config.simSinkAccountId!,
    () => process.env.SIM_SINK_PRIVATE_KEY ?? "",
  );
}
