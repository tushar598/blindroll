/**
 * Calm, small notices that state the trust model and the testnet simulation honestly.
 * Wording follows docs/08-privacy-model.md; do not strengthen it.
 */

/** Who can read what. Shown on the claim page and the run page. */
export function TrustNotice() {
  return (
    <aside className="border border-[#0667DC]/25 bg-[#e8f1fc] px-4 py-3 text-xs font-mono leading-5 text-[#322E25]/80" aria-label="Trust model">
      <p className="font-semibold uppercase tracking-wider text-[#0667DC]">What Blindroll can see</p>
      <p className="mt-1">
        The Blindroll server can read the full payroll table (it is encrypted at rest). It shows a recipient only their own row, after a valid wallet signature.
        On-chain, only the Merkle root and the report hash are public; a claim reveals that one recipient&apos;s address and amount.
        Future work: run the backend in a TEE.
      </p>
    </aside>
  );
}

/** Shown wherever 1Click options or simulated payout statuses appear (test networks only). */
export function CrossChainSimNotice() {
  return (
    <aside className="border border-[#8a5a00]/40 bg-[#fbf0d6] px-4 py-3 text-xs font-mono leading-5 text-[#8a5a00]" aria-label="Cross-chain delivery is simulated">
      <p className="font-semibold uppercase tracking-wider">Cross-chain delivery is simulated on testnet</p>
      <p className="mt-1">
        1Click has no testnet. The quotes are real 1Click estimates at mainnet prices (a quote moves no funds). On a simulated claim the contract really pays the
        test USDC to a holding account, and nothing arrives on the destination chain. A refund test simulates the failure; the refund itself is a real transfer
        from the holding account back to the contract. Real delivery requires mainnet.
      </p>
    </aside>
  );
}

/** Marks the one payout rail that is real end to end. */
export function RealBadge({ network }: { network: string }) {
  return (
    <span className="border border-[#0667DC]/40 bg-[#e8f1fc] px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-[#0667DC]">
      {network === "mainnet" ? "Real" : "Real on testnet"}
    </span>
  );
}
