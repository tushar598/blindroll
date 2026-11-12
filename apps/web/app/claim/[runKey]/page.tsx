import { Suspense } from "react";
import { ClaimScreen } from "../../components/claim-screen";

export default function ClaimPage() {
  return (
    <Suspense fallback={<p className="text-sm font-mono text-[#322E25]/60">Loading…</p>}>
      <ClaimScreen />
    </Suspense>
  );
}
