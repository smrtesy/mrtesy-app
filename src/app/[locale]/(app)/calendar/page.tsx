export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CheckSquare, Calendar, ExternalLink } from "lucide-react";

interface TimelineItem {
  id: string;
  type: "task" | "event";
  title: string;
  date: string; // ISO date string
  priority?: string;
  sourceUrl?: string;
  classification?: string;
}

export default async function CalendarPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("calendar");
  const tTasks = await getTranslations("tasks");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  const dateFmtLocale = locale === "he" ? "he-IL" : "en-US";
  const today = new Date().toISOString().split("T")[0];

  // Fetch future calendar events only
  const { data: events } = await supabase
    .from("source_messages")
    .select("id, subject, source_url, received_at, ai_classification")
    .eq("user_id", user.id)
    .eq("source_type", "google_calendar")
    .gte("received_at", new Date().toISOString())
    .order("received_at", { ascending: true })
    .limit(100);

  // Fetch tasks with due dates (future only)
  const { data: tasksWithDates } = await supabase
    .from("tasks")
    .select("id, title, title_he, due_date, priority, status")
    .eq("user_id", user.id)
    .not("due_date", "is", null)
    .gte("due_date", today)
    .neq("status", "archived")
    .order("due_date", { ascending: true })
    .limit(50);

  // Merge into unified timeline
  const timeline: TimelineItem[] = [];

  for (const task of tasksWithDates || []) {
    timeline.push({
      id: `task-${task.id}`,
      type: "task",
      title: locale === "he" && task.title_he ? task.title_he : task.title,
      date: task.due_date!,
      priority: task.priority,
    });
  }

  for (const event of events || []) {
    const eventDate = event.received_at?.split("T")[0] || today;
    timeline.push({
      id: `event-${event.id}`,
      type: "event",
      title: event.subject || (locale === "he" ? "(ללא כותרת)" : "(No title)"),
      date: eventDate,
      sourceUrl: event.source_url,
      classification: event.ai_classification,
    });
  }

  // Sort by date, then by type (events first for same date)
  timeline.sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.type === "event" ? -1 : 1;
  });

  // Group by date
  const grouped: Record<string, TimelineItem[]> = {};
  for (const item of timeline) {
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  }
  const sortedDates = Object.keys(grouped).sort();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>

      {sortedDates.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Calendar className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>{t("noTasksWithDates")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {sortedDates.map((date) => {
            const items = grouped[date];
            const isToday = date === today;

            return (
              <div key={date}>
                <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
                  {new Date(date + "T00:00:00").toLocaleDateString(dateFmtLocale, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                  {isToday && (
                    <Badge variant="default" className="text-[10px]">
                      {locale === "he" ? "היום" : "Today"}
                    </Badge>
                  )}
                </h3>
                <div className="space-y-1.5">
                  {items.map((item) => (
                    <Card key={item.id}>
                      <CardContent className="p-3 flex items-center gap-3">
                        {/* Type icon */}
                        <div className={`shrink-0 rounded-full p-1.5 ${
                          item.type === "task" ? "bg-green-100" : "bg-blue-100"
                        }`}>
                          {item.type === "task" ? (
                            <CheckSquare className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Calendar className="h-3.5 w-3.5 text-blue-600" />
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{item.title}</p>
                        </div>

                        {/* Badges & links */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.priority && (
                            <Badge variant="outline" className="text-[10px]">
                              {tTasks(`priority.${item.priority}`)}
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
