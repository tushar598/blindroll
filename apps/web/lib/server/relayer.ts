import { serverConfig } from "./config";
import { parseRelayerKey, signTransaction } from "./near-tx";
import { type TxOutcome, accessKeyNonce, sendTransaction } from "./rpc";

export type RelayFn = (call: { receiverId: string; methodName: string; args: object; gasTgas: number }) => Promise<TxOutcome>;

// One transaction at a time, so two claims never reuse the same access-key nonce.
let queue: Promise<unknown> = Promise.resolve();

/** Sends one function call from the relayer account, which pays the gas. The key never leaves this module. */
export const relay: RelayFn = (call) => {
  const run = async () => {
    const key = parseRelayerKey(process.env.RELAYER_PRIVATE_KEY ?? "");
    const signerId = serverConfig().relayerAccountId;
    const { nonce, blockHash } = await accessKeyNonce(signerId, key.publicKey);
    const { signedBase64 } = signTransaction(
      {
        signerId,
        receiverId: call.receiverId,
        nonce: nonce + 1n,
        blockHash,
        methodName: call.methodName,
        args: call.args,
        gas: BigInt(call.gasTgas) * 1_000_000_000_000n,
        deposit: 0n,
      },
      key,
    );
    return sendTransaction(signedBase64);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
};
