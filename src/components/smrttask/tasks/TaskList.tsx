"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { SmartSearch } from "./SmartSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
      setSelected(new Set());
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function handleBulkDismissFast(ids: string[]) {
    if (ids.length === 0) return;
    try {
      await api(`/api/tasks/bulk-dismiss-fast`, { method: "POST", body: { task_ids: ids } });
      toast.success(t("actions.complete"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

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

  const baseTasks = searchResults !== null ? searchResults : tasks;
  const displayTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return baseTasks;
    return baseTasks.filter((task) => {
      const haystack = [
        task.title, task.title_he, task.description, task.related_contact, task.related_contact_email,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [baseTasks, searchQuery]);

  function selectAllFiltered() { setSelected(new Set(displayTasks.map((t) => t.id))); }

  return (
    <div className="space-y-4">
      {/* Search */}
      <SmartSearch
        onResults={(results) => setSearchResults(results.length > 0 ? results : null)}
      />

      {/* Filter Tabs */}
      <Tabs value={filter} onValueChange={(v) => { setFilter(v); setSearchResults(null); setSelected(new Set()); }} dir={locale === "he" ? "rtl" : "ltr"}>
        <TabsList>
          <TabsTrigger value="inbox">{t("inbox")}</TabsTrigger>
          <TabsTrigger value="active">{t("active")}</TabsTrigger>
          <TabsTrigger value="completed">{t("completed")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Search + bulk-select toolbar */}
      <SuggestionToolbar
        total={baseTasks.length}
        filtered={displayTasks.length}
        selectedCount={selected.size}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelectAll={selectAllFiltered}
        onClearSelection={clearSelection}
        onBulkDismissFast={() => handleBulkDismissFast(Array.from(selected))}
      />

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
              selected={selected.has(task.id)}
              onToggleSelect={toggleSelect}
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
