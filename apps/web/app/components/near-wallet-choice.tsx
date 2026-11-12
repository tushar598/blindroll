"use client";
import { useReducer } from "react";
import { activeWalletId, activeWalletLabel, enabledWallets, setActiveWallet } from "@/lib/client/wallet";

/**
 * The NEAR wallet used for the next connect or signature. Read at render time; the parent re-renders
 * when the deployment's wallet list arrives (it calls `configureWallets` first).
 */
export function useNearWalletChoice() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
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

/** Wallet picker. Renders nothing when the deployment offers a single wallet (the default: Meteor). */
export function NearWalletChoice({ choice, disabled, onChange }: { choice: ReturnType<typeof useNearWalletChoice>; disabled?: boolean; onChange?: () => void }) {
  if (choice.wallets.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-mono" role="group" aria-label="NEAR wallet">
      <span className="text-[#322E25]/70">NEAR wallet:</span>
      {choice.wallets.map((w) => (
        <button
          key={w.id}
          type="button"
          aria-pressed={w.id === choice.activeId}
          disabled={disabled}
          onClick={() => {
            choice.choose(w.id);
            onChange?.();
          }}
          className={`border px-2.5 py-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${w.id === choice.activeId ? "border-[#0667DC] bg-[#0667DC] text-white" : "border-[#322E25]/30 text-[#322E25] hover:border-[#0667DC]"}`}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
