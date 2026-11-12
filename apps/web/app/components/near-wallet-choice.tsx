"use client";
import { useEffect, useReducer, useState } from "react";
import { activeWalletId, activeWalletLabel, enabledWallets, loadWalletOptions, setActiveWallet } from "@/lib/client/wallet";

/**
 * The NEAR wallet used for the next connect or signature. Read at render time; the parent re-renders
 * when the deployment's wallet list arrives (it calls `configureWallets` first). With `network`,
 * the wallet modules are loaded once so the picker can show their icons.
 */
export function useNearWalletChoice(network?: string) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!network) return;
    let live = true;
    loadWalletOptions(network).then(() => live && rerender());
    return () => {
      live = false;
    };
  }, [network]);
  return {
    label: activeWalletLabel(),
    activeId: activeWalletId(),
    wallets: enabledWallets(),
    choose(id: string) {
      setActiveWallet(id);
      rerender();
    },
  };
}

function Icon({ src, label }: { src: string | null; label: string }) {
  if (!src) return <span className="flex h-6 w-6 items-center justify-center border border-[#322E25]/20 text-[10px]" aria-hidden>{label[0]}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- inline data URI from the wallet module
  return <img src={src} alt="" className="h-6 w-6 object-contain" />;
}

function TestedBadge({ tested }: { tested: boolean }) {
  return tested ? (
    <span className="border border-[#0667DC]/40 bg-[#e8f1fc] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#0667DC]">Tested</span>
  ) : (
    <span className="border border-[#322E25]/25 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#322E25]/60">Untested</span>
  );
}

/** Wallet picker: the current wallet and a "Change" button that opens a modal. Hidden with one wallet. */
export function NearWalletChoice({ choice, disabled, onChange }: { choice: ReturnType<typeof useNearWalletChoice>; disabled?: boolean; onChange?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (choice.wallets.length < 2) return null;
  const current = choice.wallets.find((w) => w.id === choice.activeId) ?? choice.wallets[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
      <span className="text-[#322E25]/70">NEAR wallet:</span>
      <span className="flex items-center gap-1.5 font-semibold text-[#322E25]">
        <Icon src={current.iconUrl} label={current.label} /> {current.label}
      </span>
      <button type="button" className="underline text-[#0667DC] disabled:opacity-40" disabled={disabled} onClick={() => setOpen(true)}>
        Change
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#322E25]/40 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose a NEAR wallet"
            className="w-full max-w-sm border border-[#322E25]/30 bg-[#E9E1CD] p-5 font-mono shadow-[4px_4px_0px_0px_#322E25]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold uppercase tracking-tight">Choose a NEAR wallet</p>
              <button type="button" className="text-sm text-[#322E25]/60" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-[#322E25]/60">&ldquo;Tested&rdquo; means we tried it end to end on testnet. Untested wallets should work but have not been tried here yet.</p>
            <ul className="mt-3 divide-y divide-[#322E25]/10 border-y border-[#322E25]/15">
              {choice.wallets.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    aria-pressed={w.id === choice.activeId}
                    className={`flex w-full items-center gap-3 px-2 py-2.5 text-left text-sm hover:bg-[#E1D7C0] ${w.id === choice.activeId ? "bg-[#E1D7C0]" : ""}`}
                    onClick={() => {
                      choice.choose(w.id);
                      setOpen(false);
                      onChange?.();
                    }}
                  >
                    <Icon src={w.iconUrl} label={w.label} />
                    <span className="flex-1 font-semibold">{w.label}</span>
                    <TestedBadge tested={w.tested} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
