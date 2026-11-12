import { Suspense } from "react";
import { ReportScreen } from "../../../components/report-screen";

export default function ReportPage() {
  return (
    <Suspense fallback={<p className="text-sm font-mono text-[#322E25]/60">Loading report…</p>}>
      <ReportScreen />
    </Suspense>
  );
}
