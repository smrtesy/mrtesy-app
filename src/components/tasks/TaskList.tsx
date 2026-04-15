"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
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

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    let query = supabase
      .from("tasks")
      .select("*, source_messages(source_type, source_url)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (filter === "inbox") {
      query = query.eq("status", "inbox");
    } else if (filter === "active") {
      query = query.eq("status", "in_progress");
    } else if (filter === "completed") {
      query = query.eq("status", "archived");
    }

    const { data } = await query;
    setTasks((data as Task[]) || []);
    setLoading(false);
  }, [filter, supabase]);

  useEffect(() => {
    fetchTasks();

    // Realtime subscription for task changes
    const channel = supabase
      .channel("tasks-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        () => {
          fetchTasks(); // Re-fetch on any change
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchTasks, supabase]);

  async function handleComplete(taskId: string) {
    const { error } = await supabase
      .from("tasks")
      .update({
        status: "archived",
        completed_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    if (error) { toast.error(error.message); return; }
    toast.success(t("actions.complete"));
    fetchTasks();
  }

  async function handleSnooze(taskId: string) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const { error } = await supabase
      .from("tasks")
      .update({
        snoozed_until: tomorrow.toISOString(),
        status: "snoozed",
      })
      .eq("id", taskId);
    if (error) { toast.error(error.message); return; }
    toast.success(t("actions.snooze"));
    fetchTasks();
  }

  function handleSelect(task: Task) {
    if (!task.seen_at) {
      supabase
        .from("tasks")
        .update({ seen_at: new Date().toISOString() })
        .eq("id", task.id)
        .then();
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
      <Tabs value={filter} onValueChange={(v) => { setFilter(v); setSearchResults(null); }}>
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
        onQuickAction={handleQuickAction}
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
