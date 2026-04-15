"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, X, Bell, Mail, MessageCircle, FolderOpen, Calendar } from "lucide-react";
import { toast } from "sonner";

const sourceIcons: Record<string, typeof Mail> = {
  gmail: Mail,
  whatsapp: MessageCircle,
  google_drive: FolderOpen,
  google_calendar: Calendar,
};

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

    // Get tasks created from AI that haven't been seen/verified
    const { data } = await supabase
      .from("tasks")
      .select("*, source_messages(source_type, sender, subject)")
      .eq("user_id", user.id)
      .eq("status", "inbox")
      .eq("manually_verified", false)
      .not("source_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);

    setSuggestions(data || []);
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
        const source = task.source_messages as any | null /* eslint-disable-line @typescript-eslint/no-explicit-any */;
        const Icon = sourceIcons[source?.source_type || "gmail"] || Mail;
        const title = locale === "he" && task.title_he ? task.title_he : task.title;

        return (
          <Card key={task.id}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-full bg-blue-100 p-2">
                  <Icon className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium text-sm">{title}</h4>
                  {task.description ? (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {task.description}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 mt-1">
                    {source?.sender && (
                      <Badge variant="outline" className="text-[10px]">
                        {source.sender}
                      </Badge>
                    )}
                    {task.priority && (
                      <Badge variant="secondary" className="text-[10px]">
                        {tTasks(`priority.${task.priority}`)}
                      </Badge>
                    )}
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
                  <span className="hidden sm:inline">{t("dismiss")}</span>
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
