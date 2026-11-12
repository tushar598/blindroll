import { Suspense } from "react";
import { RunScreen } from "../../components/run-screen";

export default function RunPage() {
  return (
    <Suspense fallback={<p className="text-sm font-mono text-[#322E25]/60">Loading run…</p>}>
      <RunScreen />
    </Suspense>
  );
}
