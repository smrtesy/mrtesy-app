"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";

interface SuggestionTask {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
}

export function ProjectSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const [suggestions, setSuggestions] = useState<SuggestionTask[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const { tasks } = await api<{ tasks: SuggestionTask[] }>(
        "/api/tasks?task_type=project_suggestion&status=inbox&limit=10",
      );
      setSuggestions(tasks ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  async function handleApprove(task: SuggestionTask) {
    try {
      await api(`/api/tasks/${task.id}/approve-as-project`, { method: "POST" });
      toast.success(t("projectCreated"));
      fetchSuggestions();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDismiss(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { status: "archived", manually_verified: true },
      });
      toast.success(t("dismiss"));
      fetchSuggestions();
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
                  onClick={() => handleDismiss(task.id)}
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
