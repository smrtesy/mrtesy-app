export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { ReachSettingsClient } from "@/components/smrtreach/ReachSettingsClient";

export default function ReachSettingsPage() {
  return (
    <div className="p-6">
      <Suspense>
        <ReachSettingsClient />
      </Suspense>
    </div>
  );
}
