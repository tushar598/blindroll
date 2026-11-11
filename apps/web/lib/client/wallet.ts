"use client";
import { Buffer } from "buffer";
import type { WalletSelector } from "@near-wallet-selector/core";

/**
 * NEAR wallet access for approvers and recipients. One wallet is wired: Meteor.
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

/** The account the wallet remembers for this site, or null. Never opens the wallet. */
export async function currentWalletAccount(network: string): Promise<string | null> {
  try {
    const wallet = await (await getSelector(network)).wallet(WALLET_ID);
    // Meteor's getAccounts() throws ("No current account connected…") instead of returning [] when
    // nothing is connected yet, so a failure here just means "not connected".
    return (await wallet.getAccounts())[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

/**
 * Connects the wallet if needed and returns the account ID.
 * `fresh` forgets the remembered connection first, so the wallet asks which account to use.
 */
export async function connectWallet(network: string, contractId: string, opts: { fresh?: boolean } = {}): Promise<string> {
  if (opts.fresh) await disconnectWallet(network);
  const remembered = opts.fresh ? null : await currentWalletAccount(network);
  if (remembered) return remembered;
  const wallet = await (await getSelector(network)).wallet(WALLET_ID);
  const first = (await wallet.signIn({ contractId, accounts: [] }))[0];
  if (!first) throw new Error("The wallet did not return an account");
  return first.accountId;
}

/**
 * Makes sure the wallet is connected as `expected` before signing. The browser remembers ONE Meteor
 * connection for this site, shared by the approver pages and the claim page, so it can point at
 * another account; then the wallet is asked to connect again.
 */
export async function ensureWalletAccount(network: string, contractId: string, expected: string): Promise<void> {
  let account = await connectWallet(network, contractId);
  if (account !== expected) account = await connectWallet(network, contractId, { fresh: true });
  if (account !== expected) {
    await disconnectWallet(network);
    throw new Error(`The wallet connected as ${account}, but this step must be signed by ${expected}. Try again and choose ${expected} in Meteor.`);
  }
}

/** True for the wallet's errors that mean "the remembered account is not available in this wallet". */
export function isWalletAccountError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /could not be found|no current account|not connected/i.test(text);
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

/**
 * Sends one function call from the wallet and throws if the transaction failed.
 * `signerId` is the account that must sign it; the wallet is reconnected if it points elsewhere.
 */
export async function callContract(
  network: string,
  p: { signerId: string; receiverId: string; methodName: string; args: object; gasTgas: number; depositYocto: string },
): Promise<TxResult> {
  const core = await import("@near-wallet-selector/core");
  await ensureWalletAccount(network, p.receiverId, p.signerId);
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
