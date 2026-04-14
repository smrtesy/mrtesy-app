"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Pause, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function ScheduledSuggestions({ locale }: { locale: string }) {
  const supabase = createClient();
  const [reminders, setReminders] = useState<any[] /* eslint-disable-line @typescript-eslint/no-explicit-any */>([]);
  const [loading, setLoading] = useState(true);

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("reminders")
      .select("*, tasks(title, title_he)")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("remind_at", { ascending: true })
      .limit(30);

    setReminders(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  async function handlePause(id: string) {
    await supabase.from("reminders").update({ is_active: false }).eq("id", id);
    toast.success("Paused");
    fetchReminders();
  }

  async function handleDelete(id: string) {
    await supabase.from("reminders").update({ is_active: false }).eq("id", id);
    toast.success("Removed");
    fetchReminders();
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  if (reminders.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Clock className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>No scheduled reminders</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {reminders.map((reminder) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = reminder.tasks as any;
        const title = locale === "he"
          ? (reminder.title_he || task?.title_he || reminder.message_he || reminder.message)
          : (task?.title || reminder.message);
        const remindAt = reminder.remind_at ? new Date(reminder.remind_at as string) : null;
        const isPast = remindAt && remindAt < new Date();

        return (
          <Card key={reminder.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium text-sm truncate">{title}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    {remindAt && (
                      <Badge variant={isPast ? "destructive" : "outline"} className="text-[10px]">
                        {remindAt.toLocaleString(locale === "he" ? "he-IL" : "en-US")}
                      </Badge>
                    )}
                    {reminder.recurrence_rule && (
                      <Badge variant="secondary" className="text-[10px]">Recurring</Badge>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => handlePause(reminder.id as string)}
                  >
                    <Pause className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-red-500"
                    onClick={() => handleDelete(reminder.id as string)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
