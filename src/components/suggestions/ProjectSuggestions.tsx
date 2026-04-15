"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";

export function ProjectSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const supabase = createClient();
  const [suggestions, setSuggestions] = useState<any[] /* eslint-disable-line @typescript-eslint/no-explicit-any */>([]);
  const [loading, setLoading] = useState(true);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .eq("task_type", "project_suggestion")
      .eq("status", "inbox")
      .order("created_at", { ascending: false })
      .limit(10);

    setSuggestions(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  async function handleApprove(task: Record<string, unknown>) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: project, error } = await supabase.from("projects").insert({
      user_id: user.id,
      name: task.title as string,
      name_he: task.title_he as string,
      template_type: "personal",
    }).select("id").single();

    if (error) {
      toast.error(error.message);
      return;
    }

    await supabase
      .from("tasks")
      .update({ status: "archived", manually_verified: true, project_id: project.id })
      .eq("id", task.id as string);

    toast.success(t("projectCreated"));
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
        {[1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Lightbulb className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noProjects")}</p>
        <p className="text-xs mt-1">{t("projectsDetectedNightly")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {suggestions.map((task) => {
        const title = locale === "he" && task.title_he ? task.title_he : task.title;
        return (
          <Card key={task.id}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-full bg-yellow-100 p-2">
                  <Lightbulb className="h-4 w-4 text-yellow-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium text-sm" dir="auto">{title}</h4>
                  {task.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2" dir="auto">
                      {task.description}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-3 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-1 text-red-500"
                  onClick={() => handleDismiss(task.id as string)}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  className="h-9 gap-1"
                  onClick={() => handleApprove(task)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("createProject")}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
