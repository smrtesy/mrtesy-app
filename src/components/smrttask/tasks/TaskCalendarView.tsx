"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckSquare, Calendar, ExternalLink, Inbox } from "lucide-react";

interface TimelineItem {
  id: string;
  type: "task" | "event";
  title: string;
  date: string; // YYYY-MM-DD
  priority?: string | null;
  sourceUrl?: string | null;
  classification?: string | null;
}

interface NoDateTask {
  id: string;
  title: string;
  priority: string | null;
}

/**
 * Calendar / timeline view of the tasks page. Two stacked sections:
 *   1. "ללא תאריך" — open tasks without a due_date (so the user doesn't
 *      lose them just because they're not scheduled).
 *   2. Date-grouped timeline of future tasks + future Google Calendar
 *      events, identical to the standalone /calendar page (which now
 *      redirects here).
 *
 * Completed/archived tasks are intentionally excluded — this view is
 * "what's coming up", not an archive. The Completed tab in the list
 * view is the place for those.
 */
export function TaskCalendarView({ locale }: { locale: string }) {
  const t = useTranslations("tasks");
  const tCal = useTranslations("tasks.calendar");
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [noDateTasks, setNoDateTasks] = useState<NoDateTask[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  const today = new Date().toISOString().split("T")[0];
  const dateFmtLocale = locale === "he" ? "he-IL" : "en-US";

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    // Three parallel queries: future events, future-dated tasks, undated tasks.
    const [eventsRes, datedRes, undatedRes] = await Promise.all([
      supabase
        .from("source_messages")
        .select("id, subject, source_url, received_at, ai_classification")
        .eq("user_id", user.id)
        .eq("source_type", "google_calendar")
        .gte("received_at", new Date().toISOString())
        .order("received_at", { ascending: true })
        .limit(100),
      supabase
        .from("tasks")
        .select("id, title, title_he, due_date, priority, status")
        .eq("user_id", user.id)
        .not("due_date", "is", null)
        .gte("due_date", today)
        .neq("status", "archived")
        .order("due_date", { ascending: true })
        .limit(100),
      supabase
        .from("tasks")
        .select("id, title, title_he, priority, status")
        .eq("user_id", user.id)
        .is("due_date", null)
        .neq("status", "archived")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    const tl: TimelineItem[] = [];
    for (const task of datedRes.data ?? []) {
      tl.push({
        id: `task-${task.id}`,
        type: "task",
        title: locale === "he" && task.title_he ? task.title_he : task.title,
        date: task.due_date as string,
        priority: task.priority,
      });
    }
    for (const ev of eventsRes.data ?? []) {
      const evDate = (ev.received_at as string | null)?.split("T")[0] ?? today;
      tl.push({
        id: `event-${ev.id}`,
        type: "event",
        title: (ev.subject as string | null) ?? "",
        date: evDate,
        sourceUrl: ev.source_url as string | null,
        classification: ev.ai_classification as string | null,
      });
    }

    // Same sort as the standalone /calendar: by date, events before tasks
    // when they share a date (events anchor the day visually).
    tl.sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return a.type === "event" ? -1 : 1;
    });

    setTimeline(tl);
    type UndatedRow = { id: string; title: string; title_he: string | null; priority: string | null };
    setNoDateTasks(
      ((undatedRes.data as UndatedRow[] | null) ?? []).map((row) => ({
        id: row.id,
        title: locale === "he" && row.title_he ? row.title_he : row.title,
        priority: row.priority ?? null,
      })),
    );
    setLoading(false);
  }, [supabase, locale, today]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: any change to tasks/source_messages refetches. Cheap (3
  // small queries) and the user expects newly-scheduled tasks to show up
  // immediately when they edit elsewhere.
  useEffect(() => {
    const ch = supabase
      .channel("calendar-view")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => load())
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "source_messages" },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, load]);

  // Group timeline by date for rendering.
  const grouped: Record<string, TimelineItem[]> = {};
  for (const item of timeline) {
    (grouped[item.date] ||= []).push(item);
  }
  const sortedDates = Object.keys(grouped).sort();

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* "ללא תאריך" section — only render if there's anything to show */}
      {noDateTasks.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Inbox className="h-4 w-4" />
            {tCal("noDateSection")}
            <span className="text-xs text-muted-foreground/70">
              ({tCal("noDateHint", { count: noDateTasks.length })})
            </span>
          </h3>
          <div className="space-y-1.5">
            {noDateTasks.map((task) => (
              <Card key={task.id}>
                <CardContent className="flex items-center gap-3 p-3">
                  <div className="shrink-0 rounded-full bg-status-warn-bg p-1.5">
                    <CheckSquare className="h-3.5 w-3.5 text-status-warn" />
                  </div>
                  <p className="flex-1 min-w-0 truncate text-sm">{task.title}</p>
                  {task.priority && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(`priority.${task.priority}` as Parameters<typeof t>[0])}
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Date-grouped timeline */}
      {sortedDates.length === 0 ? (
        noDateTasks.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            <Calendar className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{tCal("emptyTimeline")}</p>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {sortedDates.map((date) => {
            const items = grouped[date];
            const isToday = date === today;
            return (
              <div key={date}>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  {new Date(date + "T00:00:00").toLocaleDateString(dateFmtLocale, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                  {isToday && (
                    <Badge variant="default" className="text-[10px]">
                      {tCal("today")}
                    </Badge>
                  )}
                </h3>
                <div className="space-y-1.5">
                  {items.map((item) => (
                    <Card key={item.id}>
                      <CardContent className="flex items-center gap-3 p-3">
                        <div
                          className={`shrink-0 rounded-full p-1.5 ${
                            item.type === "task" ? "bg-status-ok-bg" : "bg-accent"
                          }`}
                        >
                          {item.type === "task" ? (
                            <CheckSquare className="h-3.5 w-3.5 text-status-ok" />
                          ) : (
                            <Calendar className="h-3.5 w-3.5 text-primary" />
                          )}
                        </div>
                        <p className="flex-1 min-w-0 truncate text-sm">{item.title}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.priority && (
                            <Badge variant="outline" className="text-[10px]">
                              {t(`priority.${item.priority}` as Parameters<typeof t>[0])}
                            </Badge>
                          )}
                          {item.classification && (
                            <Badge variant="outline" className="text-[10px]">
                              {item.classification}
                            </Badge>
                          )}
                          {item.sourceUrl && (
                            <a
                              href={item.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
