"use client";

/**
 * Client wrapper that mounts the MergeJobProvider and the floating chip.
 * Lives one level inside the locale layout so the layout can stay a
 * server component (which it needs to be for next-intl messages).
 */

import { MergeJobProvider } from "@/contexts/MergeJobContext";
import { BackgroundMergeChip } from "@/components/smrttask/merge/BackgroundMergeChip";

export function MergeJobShell({ locale, children }: { locale: string; children: React.ReactNode }) {
  return (
    <MergeJobProvider>
      {children}
      <BackgroundMergeChip locale={locale} />
    </MergeJobProvider>
  );
}
