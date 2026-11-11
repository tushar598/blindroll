"use client";
import { Buffer } from "buffer";
import type { WalletSelector } from "@near-wallet-selector/core";

/**
 * NEAR wallet access for approvers. One wallet is wired: Meteor (the owner's approver wallet).
 * Loaded lazily so nothing wallet-related runs on the server.
 */
const WALLET_ID = "meteor-wallet";
let selector: Promise<WalletSelector> | undefined;

function getSelector(network: string): Promise<WalletSelector> {
  if (network !== "testnet" && network !== "mainnet") throw new Error(`Wallets are not available on network "${network}"`);
  selector ??= (async () => {
    const [{ setupWalletSelector }, { setupMeteorWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/meteor-wallet"),
    ]);
    return setupWalletSelector({ network, modules: [setupMeteorWallet()] });
  })();
  return selector;
}

/** Connects the wallet if needed and returns the account ID. */
export async function connectWallet(network: string, contractId: string): Promise<string> {
  const wallet = await (await getSelector(network)).wallet(WALLET_ID);
  let accounts = await wallet.getAccounts();
  if (accounts.length === 0) accounts = await wallet.signIn({ contractId, accounts: [] });
  const first = accounts[0];
  if (!first) throw new Error("The wallet did not return an account");
  return first.accountId;
}

export async function disconnectWallet(network: string): Promise<void> {
  try {
    const wallet = await (await getSelector(network)).wallet(WALLET_ID);
    await wallet.signOut();
  } catch {
    /* already disconnected */
  }
}

/** NEP-413 message signature for sign-in. `nonceBase64` is the server's one-time 32-byte nonce. */
export async function signInMessage(network: string, p: { message: string; recipient: string; nonceBase64: string }) {
  const wallet = await (await getSelector(network)).wallet(WALLET_ID);
  if (!wallet.signMessage) throw new Error("This wallet cannot sign messages");
  const signed = await wallet.signMessage({ message: p.message, recipient: p.recipient, nonce: Buffer.from(p.nonceBase64, "base64") });
  if (!signed) throw new Error("The wallet did not return a signature");
  return signed;
}

export interface TxResult {
  txHash: string | null;
}

/** Sends one function call from the connected wallet and throws if the transaction failed. */
export async function callContract(
  network: string,
  p: { receiverId: string; methodName: string; args: object; gasTgas: number; depositYocto: string },
): Promise<TxResult> {
  const core = await import("@near-wallet-selector/core");
  const wallet = await (await getSelector(network)).wallet(WALLET_ID);
  const outcome = await wallet.signAndSendTransaction({
    receiverId: p.receiverId,
    actions: [
      core.internalActionToNaj({
        type: "FunctionCall",
        params: { methodName: p.methodName, args: p.args, gas: (BigInt(p.gasTgas) * 1_000_000_000_000n).toString(), deposit: p.depositYocto },
      }),
    ],
  });
  if (!outcome) return { txHash: null };
  const status = outcome.status as { Failure?: unknown } | string;
  if (typeof status === "object" && status.Failure !== undefined) {
    throw new Error(`The transaction failed on-chain: ${JSON.stringify(status.Failure).slice(0, 300)}`);
  }
  return { txHash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? null };
}

export function explorerTx(network: string, txHash: string): string {
  return `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${txHash}`;
}
export function explorerAccount(network: string, accountId: string): string {
  return `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/address/${accountId}`;
}
