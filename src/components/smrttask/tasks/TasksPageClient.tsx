"use client";

import { useParams } from "next/navigation";
import { TaskList } from "./TaskList";
import { UpcomingBanner } from "./UpcomingBanner";
import { ClaudeActivityBar } from "@/components/claude/ClaudeActivityBar";

/**
 * Top-level chrome for /tasks — the desk page. The old list/calendar view
 * toggle is gone (the calendar view was removed with the desk redesign).
 * The morning inbox auto-redirect was removed (workclock's morning ritual
 * replaces it — docs/workclock-plan.md §9.2).
 */
export function TasksPageClient({ title }: { title: string }) {
  const { locale } = useParams();

  return (
    <div className="space-y-4">
      {/* Claude completions, in view while working at the desk. Renders nothing
          when there is nothing unseen (compact-by-default). */}
      <ClaudeActivityBar />
      <UpcomingBanner locale={locale as string} />
      {/* The page title now lives inside TaskList, on the same row as the
          context filter. */}
      <TaskList locale={locale as string} title={title} />
    </div>
  );
}
