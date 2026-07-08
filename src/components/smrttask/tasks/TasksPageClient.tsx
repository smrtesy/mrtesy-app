"use client";

import { useParams } from "next/navigation";
import { TaskList } from "./TaskList";
import { UpcomingBanner } from "./UpcomingBanner";
import { MorningInboxRedirect } from "@/components/smrttask/suggestions/MorningStart";

/**
 * Top-level chrome for /tasks — the desk page. The old list/calendar view
 * toggle is gone (the calendar view was removed with the desk redesign).
 */
export function TasksPageClient({ title }: { title: string }) {
  const { locale } = useParams();

  return (
    <div className="space-y-4">
      <MorningInboxRedirect locale={locale as string} />
      <UpcomingBanner locale={locale as string} />
      {/* The page title now lives inside TaskList, on the same row as the
          context filter. */}
      <TaskList locale={locale as string} title={title} />
    </div>
  );
}
