"use client";
import { Buffer } from "buffer";
import type { WalletSelector } from "@near-wallet-selector/core";

/**
 * NEAR wallet access for approvers and recipients, loaded lazily so nothing wallet-related runs on
 * the server. Every flow needs only two things from a wallet: a NEP-413 message signature made
 * with a full-access key (sign-in, "view my payout") and, for approvers and for recipients who
 * send a payout to another account, `signAndSendTransaction`. Gas-free claims need no more
 * (docs/07), so any Wallet Selector wallet with in-page `signMessage` fits.
 *
 * Every wallet below works on testnet and is offered by default; NEAR_WALLETS only narrows the
 * list (lib/server/config.ts). `tested` says what was really tried in a browser (docs/07).
 * Wallet Selector is deprecated upstream; a move to NEAR Connect is planned (docs/12 "Later").
 */
interface WalletDef {
  label: string;
  /** Tried end to end in a browser on testnet (sign-in, a transaction, a claim). */
  tested: boolean;
  /** The wallet signs NEP-413 messages. All offered wallets do; kept so the check stays explicit. */
  signsMessages: boolean;
  /**
   * The wallet needs a callbackUrl for signMessage and puts it into the signed payload
   * (no offered wallet does today; MyNearWallet did before it was removed). We pass the current page
   * and send the same value to the server, which only accepts this app's own origin.
   */
  signsWithCallbackUrl: boolean;
  load: () => Promise<WalletModuleFactory>;
}
type WalletModuleFactory = Parameters<typeof import("@near-wallet-selector/core").setupWalletSelector>[0]["modules"][number];

const WALLETS = {
  "meteor-wallet": { label: "Meteor", tested: true, signsMessages: true, signsWithCallbackUrl: false, load: () => import("@near-wallet-selector/meteor-wallet").then((m) => m.setupMeteorWallet()) },
  "intear-wallet": { label: "Intear", tested: true, signsMessages: true, signsWithCallbackUrl: false, load: () => import("@near-wallet-selector/intear-wallet").then((m) => m.setupIntearWallet()) },
} satisfies Record<string, WalletDef>;
type WalletId = keyof typeof WALLETS;
/** Shown when a wallet cannot sign messages (sign-in and the claim page's view step need it). */
export const NO_SIGN_MESSAGE =
  "This wallet can't sign messages, which sign-in and viewing your payout need; use Meteor or Intear for this step.";
const DEFAULT_WALLET: WalletId = "meteor-wallet";
const ACTIVE_KEY = "blindroll.near-wallet";

let enabled: WalletId[] = [DEFAULT_WALLET];
let selector: Promise<WalletSelector> | undefined;

/** Sets which wallets this deployment offers (from the server). Unknown IDs are ignored. */
export function configureWallets(ids: readonly string[] | undefined): void {
  const next = (ids ?? []).filter((id): id is WalletId => id in WALLETS);
  if (!next.includes(DEFAULT_WALLET)) next.unshift(DEFAULT_WALLET);
  if (next.join() === enabled.join()) return;
  enabled = next;
  selector = undefined;
}

export interface WalletOption {
  id: string;
  label: string;
  tested: boolean;
  /** Data URI from the wallet module (nothing is fetched); null until the modules are loaded. */
  iconUrl: string | null;
}

export function enabledWallets(): WalletOption[] {
  return enabled.map((id) => ({ id, label: WALLETS[id].label, tested: WALLETS[id].tested, iconUrl: icons.get(id) ?? null }));
}

const icons = new Map<string, string>();

/** Loads the wallet modules once and returns the offered wallets with their icons. */
export async function loadWalletOptions(network: string): Promise<WalletOption[]> {
  try {
    const sel = await getSelector(network);
    for (const m of sel.store.getState().modules) {
      // Only inline icons: a module whose icon is a remote URL gets none, so nothing is fetched.
      if (m.metadata.iconUrl?.startsWith("data:")) icons.set(m.id, m.metadata.iconUrl);
    }
  } catch {
    /* icons are optional */
  }
  return enabledWallets();
}

/** The wallet used for the next connect or signature: the one last chosen in this browser, if still offered. */
export function activeWalletId(): string {
  try {
    const saved = window.localStorage.getItem(ACTIVE_KEY);
    if (saved && (enabled as string[]).includes(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return enabled[0] ?? DEFAULT_WALLET;
}

export function activeWalletLabel(): string {
  return WALLETS[activeWalletId() as WalletId].label;
}

export function setActiveWallet(id: string): void {
  if (!(enabled as string[]).includes(id)) return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

function getSelector(network: string): Promise<WalletSelector> {
  if (network !== "testnet" && network !== "mainnet") throw new Error(`Wallets are not available on network "${network}"`);
  selector ??= (async () => {
    // One wallet's module failing to load must never take the others (Meteor) down with it.
    const [{ setupWalletSelector }, ...loaded] = await Promise.all([
      import("@near-wallet-selector/core"),
      ...enabled.map((id) => WALLETS[id].load().catch(() => null)),
    ]);
    const modules = loaded.filter((m): m is WalletModuleFactory => m !== null);
    return setupWalletSelector({ network, modules });
  })();
  return selector;
}

/** The account the wallet remembers for this site, or null. Never opens the wallet. */
export async function currentWalletAccount(network: string): Promise<string | null> {
  try {
    const wallet = await (await getSelector(network)).wallet(activeWalletId());
    // Meteor's getAccounts() throws ("No current account connected…") instead of returning [] when
    // nothing is connected yet, so a failure here just means "not connected".
    return (await wallet.getAccounts())[0]?.accountId || null;
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
  const wallet = await (await getSelector(network)).wallet(activeWalletId());
  const first = (await wallet.signIn({ contractId, accounts: [] }))[0];
  if (!first) throw new Error("The wallet did not return an account");
  return first.accountId;
}

/**
 * Makes sure the wallet is connected as `expected` before signing. The browser remembers ONE wallet
 * connection for this site, shared by the approver pages and the claim page, so it can point at
 * another account; then the wallet is asked to connect again.
 */
export async function ensureWalletAccount(network: string, contractId: string, expected: string): Promise<void> {
  let account = await connectWallet(network, contractId);
  if (account !== expected) account = await connectWallet(network, contractId, { fresh: true });
  if (account !== expected) {
    await disconnectWallet(network);
    throw new Error(`The wallet connected as ${account}, but this step must be signed by ${expected}. Try again and choose ${expected} in ${activeWalletLabel()}.`);
  }
}

/** True for the wallet's errors that mean "the remembered account is not available in this wallet". */
export function isWalletAccountError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /could not be found|no current account|not connected/i.test(text);
}

export async function disconnectWallet(network: string): Promise<void> {
  try {
    const wallet = await (await getSelector(network)).wallet(activeWalletId());
    await wallet.signOut();
  } catch {
    /* already disconnected */
  }
}

/** True when the chosen wallet can make NEP-413 message signatures. */
export function activeWalletSignsMessages(): boolean {
  return WALLETS[activeWalletId() as WalletId].signsMessages;
}

/**
 * NEP-413 message signature (sign-in and the claim page's view step). `nonceBase64` is the
 * server's one-time 32-byte nonce. `callbackUrl` is returned when the wallet signed one; send it
 * to the server with the signature.
 */
export async function signInMessage(network: string, p: { message: string; recipient: string; nonceBase64: string }) {
  const def = WALLETS[activeWalletId() as WalletId];
  if (!def.signsMessages) throw new Error(NO_SIGN_MESSAGE);
  const wallet = await (await getSelector(network)).wallet(activeWalletId());
  if (!wallet.signMessage) throw new Error(NO_SIGN_MESSAGE);
  const callbackUrl = def.signsWithCallbackUrl ? window.location.href : undefined;
  let signed: Awaited<ReturnType<NonNullable<typeof wallet.signMessage>>>;
  try {
    signed = await wallet.signMessage({ message: p.message, recipient: p.recipient, nonce: Buffer.from(p.nonceBase64, "base64"), ...(callbackUrl ? { callbackUrl } : {}) });
  } catch (err) {
    if (/not supported/i.test(err instanceof Error ? err.message : String(err))) throw new Error(NO_SIGN_MESSAGE);
    throw err;
  }
  if (!signed) throw new Error("The wallet did not return a signature");
  // Some wallets hand back a PublicKey object or raw signature bytes instead of strings.
  const raw = signed as { publicKey: unknown; signature: unknown };
  const publicKey = String(raw.publicKey);
  const signature = signatureToBase64(raw.signature);
  return { accountId: signed.accountId, publicKey, signature, ...(callbackUrl ? { callbackUrl } : {}) };
}

/**
 * Wallet signatures arrive as base64 strings, Uint8Arrays, plain number arrays, or (after an
 * extension's postMessage) `{ type: "Buffer", data: [...] }` or index-keyed objects.
 */
function signatureToBase64(sig: unknown): string {
  if (typeof sig === "string") return sig;
  if (sig instanceof Uint8Array) return Buffer.from(sig).toString("base64");
  if (Array.isArray(sig)) return Buffer.from(sig as number[]).toString("base64");
  if (sig && typeof sig === "object") {
    const o = sig as { data?: unknown };
    if (Array.isArray(o.data)) return Buffer.from(o.data as number[]).toString("base64");
    const vals = Object.values(sig as Record<string, unknown>);
    if (vals.length > 0 && vals.every((v) => typeof v === "number")) return Buffer.from(vals as number[]).toString("base64");
  }
  return String(sig);
}

/**
 * True when the wallet could not open its popup. Web wallets (Intear) open one popup to
 * connect and another to sign; the browser blocks the second when it is not the direct result of a
 * click, so the caller asks for one more click instead of failing.
 */
export function isPopupBlockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /popup/i.test(msg) && /block/i.test(msg);
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
  const wallet = await (await getSelector(network)).wallet(activeWalletId());
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
