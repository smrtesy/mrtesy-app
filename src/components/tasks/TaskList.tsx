"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
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

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    let query = supabase
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (filter === "inbox") {
      query = query.eq("status", "inbox");
    } else if (filter === "active") {
      query = query.in("status", ["inbox", "in_progress"]);
    } else if (filter === "completed") {
      query = query.eq("status", "archived");
    }

    const { data } = await query;
    setTasks((data as Task[]) || []);
    setLoading(false);
  }, [filter, supabase]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  async function handleComplete(taskId: string) {
    await supabase
      .from("tasks")
      .update({
        status: "archived",
        completed_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    toast.success(t("actions.complete"));
    fetchTasks();
  }

  async function handleSnooze(taskId: string) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    await supabase
      .from("tasks")
      .update({
        snoozed_until: tomorrow.toISOString(),
        status: "snoozed",
      })
      .eq("id", taskId);
    toast.success(t("actions.snooze"));
    fetchTasks();
  }

  function handleSelect(task: Task) {
    // Mark as seen
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
    // Will be fully implemented in Step 9
    toast.info(`Quick Action: ${action.label}`);
  }

  return (
    <div className="space-y-4">
      {/* Filter Tabs */}
      <Tabs value={filter} onValueChange={setFilter}>
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
      ) : tasks.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>{t("title")}</p>
          <p className="text-sm mt-1">No tasks in this view</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              locale={locale}
              onSelect={handleSelect}
              onComplete={handleComplete}
              onSnooze={handleSnooze}
              onQuickAction={handleQuickAction}
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
      />
    </div>
  );
}
