"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, X, Bell } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";

interface SourceJoin {
  source_type: string | null;
  source_url: string | null;
  serial_display: string | null;
}

export function MessageSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("tasks")
      .select("*, source_messages(source_type, source_url, serial_display)")
      .eq("user_id", user.id)
      .eq("status", "inbox")
      .eq("manually_verified", false)
      .not("source_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);

    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const sorted = (data || []).sort(
      (a: any, b: any) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) // eslint-disable-line @typescript-eslint/no-explicit-any
    );
    setSuggestions(sorted);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  async function handleApprove(taskId: string) {
    await supabase
      .from("tasks")
      .update({ manually_verified: true, seen_at: new Date().toISOString() })
      .eq("id", taskId);
    toast.success(t("approve"));
    fetchSuggestions();
  }

  async function handleDismiss(taskId: string) {
    await supabase
      .from("tasks")
      .update({ status: "archived", manually_verified: true })
      .eq("id", taskId);
    toast.success(t("dismiss"));
    fetchSuggestions();
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Bell className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noSuggestions")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {suggestions.map((task) => {
        const source = (Array.isArray(task.source_messages) ? task.source_messages[0] : task.source_messages) as SourceJoin | null;
        const title = locale === "he" && task.title_he ? task.title_he : task.title;
        const dueDate = task.due_date
          ? new Date(task.due_date as string).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", { day: "numeric", month: "short" })
          : null;

        return (
          <Card key={task.id}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-full bg-blue-100 p-2">
                  <Bell className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-sm" dir="auto">{title}</h4>
                    <SerialBadge serial={task.serial_display as string | null} />
                    <SourceLink source={source} />
                    {dueDate && (
                      <Badge variant="outline" className="text-[10px] bg-blue-50 shrink-0">
                        {dueDate}
                      </Badge>
                    )}
                  </div>
                  {task.description ? (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2" dir="auto">
                      {task.description}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {task.related_contact && (
                      <Badge variant="outline" className="text-[10px]">
                        {task.related_contact as string}
                      </Badge>
                    )}
                    {task.priority && (
                      <Badge variant="secondary" className="text-[10px]">
                        {tTasks(`priority.${task.priority}`)}
                      </Badge>
                    )}
                    {(task.tags as string[] | null)?.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] capitalize">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 mt-3 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 min-w-[48px] gap-1 text-red-500 hover:text-red-600"
                  onClick={() => handleDismiss(task.id as string)}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  className="h-9 min-w-[48px] gap-1"
                  onClick={() => handleApprove(task.id as string)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("approve")}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
