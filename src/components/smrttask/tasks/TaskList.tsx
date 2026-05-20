"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { SmartSearch } from "./SmartSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import type { Task } from "@/types/task";

export function TaskList({ locale }: { locale: string }) {
  const t = useTranslations("tasks");
  const supabase = createClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("inbox");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<Task[] | null>(null);

  // QuickAction state
  const [qaOpen, setQaOpen] = useState(false);
  const [qaTaskId, setQaTaskId] = useState("");
  const [qaLabel, setQaLabel] = useState("");
  const [qaPrompt, setQaPrompt] = useState("");

  // DriveSearch state
  const [dsOpen, setDsOpen] = useState(false);
  const [dsTaskId, setDsTaskId] = useState("");
  const [dsDescription, setDsDescription] = useState("");

  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter === "inbox")     { params.set("status", "inbox"); params.set("verified", "true"); }
      else if (filter === "active")    { params.set("status", "in_progress"); }
      else if (filter === "completed") { params.set("status", "archived"); }
      params.set("limit", "50");

      const { tasks: rows } = await api<{ tasks: Task[] }>(`/api/tasks?${params}`);

      // Sort by priority: urgent > high > medium > low
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      const sorted = (rows ?? []).sort(
        (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
      );
      setTasks(sorted);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTasks();

    // Realtime subscription for task changes
    const channel = supabase
      .channel("tasks-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        () => {
          // Debounce: batch rapid changes (e.g. AI processing 20 tasks at once)
          // into a single refetch 400ms after the last event.
          if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
          refetchTimerRef.current = setTimeout(fetchTasks, 400);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [fetchTasks, supabase]);

  async function handleComplete(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/complete`, { method: "POST" });
      toast.success(t("actions.complete"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleSnooze(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/snooze`, { method: "POST" });
      toast.success(t("actions.snooze"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleActivate(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { status: "in_progress" },
      });
      toast.success(t("actions.activate"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleDelete(taskId: string) {
    if (!window.confirm(t("actions.deleteConfirm"))) return;
    try {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      toast.success(t("actions.deleted"));
      setDetailOpen(false);
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  function handleSelect(task: Task) {
    if (!task.seen_at) {
      // Fire-and-forget; if it fails we just don't update the indicator
      api(`/api/tasks/${task.id}/seen`, { method: "POST" }).catch(() => {});
    }
    setSelectedTask(task);
    setDetailOpen(true);
  }

  function handleQuickAction(taskId: string, action: { label: string; prompt: string }) {
    setQaTaskId(taskId);
    setQaLabel(action.label);
    setQaPrompt(action.prompt);
    setQaOpen(true);
  }

  function handleDriveSearch(taskId: string, description: string) {
    setDsTaskId(taskId);
    setDsDescription(description);
    setDsOpen(true);
  }

  const displayTasks = searchResults !== null ? searchResults : tasks;

  return (
    <div className="space-y-4">
      {/* Search */}
      <SmartSearch
        onResults={(results) => setSearchResults(results.length > 0 ? results : null)}
      />

      {/* Filter Tabs */}
      <Tabs value={filter} onValueChange={(v) => { setFilter(v); setSearchResults(null); }} dir={locale === "he" ? "rtl" : "ltr"}>
        <TabsList>
          <TabsTrigger value="inbox">{t("inbox")}</TabsTrigger>
          <TabsTrigger value="active">{t("active")}</TabsTrigger>
          <TabsTrigger value="completed">{t("completed")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Task Cards */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      ) : displayTasks.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>{t("title")}</p>
          <p className="text-sm mt-1">{t("noTasksInView")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              locale={locale}
              onSelect={handleSelect}
              onComplete={handleComplete}
              onSnooze={handleSnooze}
              onActivate={handleActivate}
              onDelete={handleDelete}
              onQuickAction={handleQuickAction}
              onDriveSearch={handleDriveSearch}
            />
          ))}
        </div>
      )}

      {/* Task Detail Panel */}
      <TaskDetail
        task={selectedTask}
        locale={locale}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onUpdate={fetchTasks}
        onDelete={handleDelete}
        onQuickAction={handleQuickAction}
        onDriveSearch={handleDriveSearch}
      />

      {/* Quick Action Sheet */}
      <QuickAction
        taskId={qaTaskId}
        actionLabel={qaLabel}
        actionPrompt={qaPrompt}
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        onDone={fetchTasks}
      />

      {/* Drive Search Sheet */}
      <DriveSearch
        taskId={dsTaskId}
        taskDescription={dsDescription}
        open={dsOpen}
        onClose={() => setDsOpen(false)}
        onDone={fetchTasks}
      />
    </div>
  );
}
