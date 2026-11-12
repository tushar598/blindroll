const LABELS: Record<string, { text: string; tone: "neutral" | "warn" | "good" | "bad" }> = {
  needs_mapping: { text: "Needs column mapping", tone: "warn" },
  review: { text: "In review", tone: "warn" },
  finalized: { text: "Finalized, not on-chain", tone: "neutral" },
  draft: { text: "On-chain: awaiting approvals", tone: "neutral" },
  approved: { text: "Approved: awaiting funds", tone: "neutral" },
  active: { text: "Active: claims open", tone: "good" },
  closed: { text: "Closed", tone: "neutral" },
  cancelled: { text: "Cancelled", tone: "bad" },
};

const TONES = {
  neutral: "border-[#322E25]/20 text-[#322E25]/70 bg-transparent",
  warn: "border-[#8a5a00]/30 bg-[#fbf0d6] text-[#8a5a00]",
  good: "border-[#0667DC]/30 bg-[#e8f1fc] text-[#0667DC]",
  bad: "border-[#a3271f]/30 bg-[#f8e6e2] text-[#a3271f]",
};

export function StatusPill({ status }: { status: string }) {
  const l = LABELS[status] ?? { text: status, tone: "neutral" as const };
  return <span className={`whitespace-nowrap border px-2.5 py-0.5 text-[10px] font-mono uppercase tracking-widest ${TONES[l.tone]}`}>{l.text}</span>;
}
