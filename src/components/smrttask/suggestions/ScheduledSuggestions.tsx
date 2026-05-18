"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Pause, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ReminderRow {
  id: string;
  remind_at: string | null;
  recurrence_rule: string | null;
  message: string | null;
  message_he: string | null;
  title_he: string | null;
  tasks: { title: string | null; title_he: string | null } | { title: string | null; title_he: string | null }[] | null;
}

export function ScheduledSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    try {
      const { reminders } = await api<{ reminders: ReminderRow[] }>(
        "/api/reminders?active=true&limit=30",
      );
      setReminders(reminders ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  async function handlePause(id: string) {
    try {
      await api(`/api/reminders/${id}`, { method: "PATCH", body: { is_active: false } });
      toast.success(t("paused"));
      fetchReminders();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/api/reminders/${id}`, { method: "DELETE" });
      toast.success(t("removed"));
      fetchReminders();
    } catch (e) {
      toast.error((e as Error).message);
    }
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
        <p>{t("noScheduled")}</p>
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
                  <h4 className="font-medium text-sm truncate" dir="auto">{title}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    {remindAt && (
                      <Badge variant={isPast ? "destructive" : "outline"} className="text-[10px]">
                        {remindAt.toLocaleString(locale === "he" ? "he-IL" : "en-US")}
                      </Badge>
                    )}
                    {reminder.recurrence_rule && (
                      <Badge variant="secondary" className="text-[10px]">{t("recurring")}</Badge>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 min-h-[48px] min-w-[48px]"
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
