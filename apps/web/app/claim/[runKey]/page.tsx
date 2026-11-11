import { Suspense } from "react";
import { ClaimScreen } from "../../components/claim-screen";

export default function ClaimPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <ClaimScreen />
    </Suspense>
  );
}
