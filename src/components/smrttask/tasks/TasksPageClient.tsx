"use client";

import { useParams } from "next/navigation";
import { TaskList } from "./TaskList";
import { UpcomingBanner } from "./UpcomingBanner";

/**
 * Top-level chrome for /tasks — the desk page. The old list/calendar view
 * toggle is gone (the calendar view was removed with the desk redesign).
 */
export function TasksPageClient({ title }: { title: string }) {
  const { locale } = useParams();

  return (
    <div className="space-y-4">
      <UpcomingBanner locale={locale as string} />
      <h1 className="text-2xl font-bold">{title}</h1>
      <TaskList locale={locale as string} />
    </div>
  );
}
