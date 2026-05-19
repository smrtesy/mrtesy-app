"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import { TaskList } from "./TaskList";
import { TaskCalendarView } from "./TaskCalendarView";
import { TasksViewToggle, type TaskView } from "./TasksViewToggle";

/**
 * Top-level chrome for /tasks. Owns the list/calendar view toggle and
 * delegates the body of the page to either the list (with its own tabs
 * + search) or the calendar timeline.
 *
 * The selected view is persisted in the `?view=` query param so the user
 * can deep-link to either mode and so /calendar can redirect here without
 * losing intent.
 */
export function TasksPageClient({ title }: { title: string }) {
  const { locale } = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialView: TaskView =
    searchParams.get("view") === "calendar" ? "calendar" : "list";
  const [view, setView] = useState<TaskView>(initialView);

  // Keep state and URL in sync (cheap shallow replace — no scroll jump).
  useEffect(() => {
    const current = searchParams.get("view");
    if (view === "calendar" && current !== "calendar") {
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", "calendar");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    } else if (view === "list" && current === "calendar") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("view");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [view, pathname, router, searchParams]);

  // Track external URL changes (e.g. /calendar → /tasks?view=calendar
  // redirect, or browser back/forward).
  const syncFromUrl = useCallback(() => {
    const next: TaskView = searchParams.get("view") === "calendar" ? "calendar" : "list";
    setView(next);
  }, [searchParams]);
  useEffect(() => {
    syncFromUrl();
  }, [syncFromUrl]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        {/* View toggle sits at the LEFT edge in RTL (after the title in
            flow order, pushed to the trailing edge with ms-auto). */}
        <div className="ms-auto">
          <TasksViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {view === "list" ? (
        <TaskList locale={locale as string} />
      ) : (
        <TaskCalendarView locale={locale as string} />
      )}
    </div>
  );
}
