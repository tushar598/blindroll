import { Suspense } from "react";
import { ReportScreen } from "../../../components/report-screen";

export default function ReportPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading report…</p>}>
      <ReportScreen />
    </Suspense>
  );
}
