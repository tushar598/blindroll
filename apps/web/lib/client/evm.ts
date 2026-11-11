"use client";

/** Minimal EVM wallet access through injected providers (EIP-1193), discovered with EIP-6963. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
export interface EvmWallet {
  id: string;
  name: string;
  provider: Eip1193Provider;
}

/** Lists installed wallets. With several extensions, `window.ethereum` is whichever won the race, so we ask each one to announce itself. */
export async function discoverEvmWallets(waitMs = 350): Promise<EvmWallet[]> {
  const found = new Map<string, EvmWallet>();
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent<{ info: { uuid: string; name: string }; provider: Eip1193Provider }>).detail;
    if (d?.info?.uuid && d.provider) found.set(d.info.uuid, { id: d.info.uuid, name: d.info.name, provider: d.provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  if (found.size === 0) {
    const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (legacy) found.set("injected", { id: "injected", name: "Browser wallet", provider: legacy });
  }
  return [...found.values()];
}

/** Asks the wallet for its account. Returns the address in lowercase (the leaf format). */
export async function connectEvm(wallet: EvmWallet): Promise<string> {
  const accounts = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("The wallet did not return an account");
  return first.toLowerCase();
}

/** personal_sign (EIP-191) of a text message. No transaction, no gas, any network. */
export async function personalSign(wallet: EvmWallet, address: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return (await wallet.provider.request({ method: "personal_sign", params: [hex, address] })) as string;
}
