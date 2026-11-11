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
  neutral: "border-line text-ink",
  warn: "border-warn/40 bg-warn-soft text-warn",
  good: "border-accent/40 bg-accent-soft text-accent",
  bad: "border-error/40 bg-error-soft text-error",
};

export function StatusPill({ status }: { status: string }) {
  const l = LABELS[status] ?? { text: status, tone: "neutral" as const };
  return <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[l.tone]}`}>{l.text}</span>;
}
