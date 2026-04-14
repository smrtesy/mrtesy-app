import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default async function CalendarPage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/login`);

  // Get calendar events from source_messages
  const { data: events } = await supabase
    .from("source_messages")
    .select("id, subject, source_url, received_at, ai_classification, ai_extraction")
    .eq("user_id", user.id)
    .eq("source_type", "google_calendar")
    .order("received_at", { ascending: true })
    .limit(50);

  // Get tasks with due dates
  const { data: tasksWithDates } = await supabase
    .from("tasks")
    .select("id, title, title_he, due_date, priority, status")
    .eq("user_id", user.id)
    .not("due_date", "is", null)
    .neq("status", "archived")
    .order("due_date", { ascending: true })
    .limit(30);

  // Group by date
  const groupedTasks: Record<string, typeof tasksWithDates> = {};
  for (const task of tasksWithDates || []) {
    const date = task.due_date!;
    if (!groupedTasks[date]) groupedTasks[date] = [];
    groupedTasks[date]!.push(task);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Calendar</h1>

      {/* Tasks with due dates */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Upcoming Tasks</h2>
        {Object.keys(groupedTasks).length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks with due dates</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(groupedTasks).map(([date, tasks]) => (
              <div key={date}>
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  {new Date(date).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </h3>
                <div className="space-y-1">
                  {tasks!.map((task) => (
                    <Card key={task.id}>
                      <CardContent className="p-3 flex items-center justify-between">
                        <span className="text-sm">{task.title_he || task.title}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {task.priority}
                        </Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Calendar events */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Calendar Events</h2>
        {(!events || events.length === 0) ? (
          <p className="text-sm text-muted-foreground">No calendar events synced yet</p>
        ) : (
          <div className="space-y-1">
            {events.map((event) => (
              <a
                key={event.id}
                href={event.source_url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between rounded border p-3 hover:bg-accent text-sm"
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate">{event.subject}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(event.received_at).toLocaleString(locale === "he" ? "he-IL" : "en-US")}
                  </p>
                </div>
                {event.ai_classification && (
                  <Badge variant="outline" className="text-[10px] ms-2">
                    {event.ai_classification}
                  </Badge>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
