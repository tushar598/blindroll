import { Suspense } from "react";
import { RunScreen } from "../../components/run-screen";

export default function RunPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading run…</p>}>
      <RunScreen />
    </Suspense>
  );
}
