"use client";

import { DayToolsSettings } from "@/components/smrttask/settings/DayToolsSettings";

/**
 * The dedicated "כלי היום" screen (opens as its own pane / route). Hosts the
 * full day-tools section that used to live inline in the smrtTask parameters
 * page — moved out to keep the parameters page focused and give the day-tools
 * (each with its own growing config) room of their own. DayToolsSettings
 * already renders its own titled Card, so this is just the page container.
 */
export function DayToolsClient() {
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <DayToolsSettings />
    </div>
  );
}
