"use client";

import { useSearchParams } from "next/navigation";
import { ExperimentScoring } from "./ExperimentScoring";

/**
 * Pane wrapper for the scoring screen.
 *
 * The app renders screens through the pane registry (src/lib/panes/registry.tsx),
 * whose `render(locale)` contract carries no query string — but this screen is
 * per-plan and needs `plan_id`. So the wrapper reads it from the URL on the
 * client. Without a registry entry the path fell through to the default screen,
 * which is why opening /plan/score just bounced back to the app's home view.
 */
export function ExperimentScoringPane() {
  const params = useSearchParams();
  return (
    <ExperimentScoring
      planId={params.get("plan_id")}
      testLabel={params.get("test")}
    />
  );
}
