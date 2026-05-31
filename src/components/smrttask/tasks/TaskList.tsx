"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { SmartSearch } from "./SmartSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { SnoozeDialog } from "./SnoozeDialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { GripVertical, ChevronDown, ChevronUp, ArrowUpDown } from "lucide-react";
import type { Task } from "@/types/task";

/** Rank for priority sorting — lower sorts first (most urgent on top). */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
type AllSort = "priority" | "date";
const ALL_SORT_KEY = "smrtesy:tasks:allSort";

/** Wrapper that adds drag handle + sortable behaviour to a TaskCard in the Today list. */
function SortableTaskCard({
  task,
  locale,
  onSelect,
  onComplete,
  onSnooze,
  onDelete,
  onQuickAction,
  onDriveSearch,
  onToggleToday,
  onPriorityChange,
}: {
  task: Task;
  locale: string;
  onSelect: (t: Task) => void;
  onComplete: (id: string) => void;
  onSnooze: (id: string) => void;
  onDelete: (id: string) => void;
  onQuickAction: (id: string, action: { label: string; prompt: string }) => void;
  onDriveSearch: (id: string, description: string) => void;
  onToggleToday: (id: string) => void;
  onPriorityChange: (id: string, priority: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex gap-2 items-start">
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="mt-3 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="גרור לשינוי סדר"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1">
        <TaskCard
          task={task}
          locale={locale}
          onSelect={onSelect}
          onComplete={onComplete}
          onSnooze={onSnooze}
          onDelete={onDelete}
          onQuickAction={onQuickAction}
          onDriveSearch={onDriveSearch}
          onToggleToday={onToggleToday}
          onPriorityChange={onPriorityChange}
        />
      </div>
    </div>
  );
}

export function TaskList({ locale }: { locale: string }) {
  const t = useTranslations("tasks");
  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [todayTasks, setTodayTasks] = useState<Task[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<Task[] | null>(null);
  const [allSort, setAllSort] = useState<AllSort>("priority");

  // Restore the user's last "All" sort choice (client-only; avoids SSR
  // hydration mismatch by reading localStorage after mount).
  useEffect(() => {
    const saved = window.localStorage.getItem(ALL_SORT_KEY);
    if (saved === "priority" || saved === "date") setAllSort(saved);
  }, []);

  const changeAllSort = useCallback((next: AllSort) => {
    setAllSort(next);
    window.localStorage.setItem(ALL_SORT_KEY, next);
  }, []);

  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // QuickAction state
  const [qaOpen, setQaOpen] = useState(false);
  const [qaTaskId, setQaTaskId] = useState("");
  const [qaLabel, setQaLabel] = useState("");
  const [qaPrompt, setQaPrompt] = useState("");
  const [qaSourceType, setQaSourceType] = useState<string | null>(null);
  const [qaPhone, setQaPhone] = useState<string | null>(null);

  // DriveSearch state
  const [dsOpen, setDsOpen] = useState(false);
  const [dsTaskId, setDsTaskId] = useState("");
  const [dsDescription, setDsDescription] = useState("");

  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const activeStatuses = "inbox,in_progress,pending_completion";

      // Fetch Today tasks (today_position IS NOT NULL), sorted by position
      const { tasks: todayRows } = await api<{ tasks: Task[] }>(
        `/api/tasks?today=true&status=${activeStatuses}&verified=true&limit=100`,
      );
      const sortedToday = (todayRows ?? []).sort(
        (a, b) => (a.today_position ?? 0) - (b.today_position ?? 0),
      );
      setTodayTasks(sortedToday);

      // Fetch All tasks (today_position IS NULL), sorted by created_at desc
      const { tasks: allRows } = await api<{ tasks: Task[] }>(
        `/api/tasks?today=false&status=${activeStatuses}&verified=true&limit=200`,
      );
      setAllTasks(allRows ?? []);

      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("smrtesy:badge-refresh"));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCompleted = useCallback(async () => {
    try {
      const { tasks: rows } = await api<{ tasks: Task[] }>(
        `/api/tasks?status=archived&limit=50`,
      );
      setCompletedTasks(rows ?? []);
    } catch {
      // non-fatal
    }
  }, []);

  // Open focused task detail after load
  useEffect(() => {
    if (!focusId || loading) return;
    if (focusedRef.current === focusId) return;
    const match = [...todayTasks, ...allTasks].find((t) => t.id === focusId);
    if (!match) return;
    focusedRef.current = focusId;
    setSelectedTask(match);
    setDetailOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [focusId, loading, todayTasks, allTasks, pathname, router, searchParams]);

  useEffect(() => {
    fetchTasks();
    const channel = supabase
      .channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => {
        if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = setTimeout(fetchTasks, 400);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [fetchTasks, supabase]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleComplete(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/complete`, { method: "POST" });
      toast.success(t("actions.complete"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleSnoozeConfirm(untilIso: string) {
    if (!snoozeTaskId) return;
    try {
      await api(`/api/tasks/${snoozeTaskId}/snooze`, { method: "POST", body: { until: untilIso } });
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
        body: { status: "in_progress", has_unread_update: false, completion_signal_detected: false, completion_signal_reason: null },
      });
      toast.success(t("actions.activate"));
      fetchTasks();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handlePriorityChange(taskId: string, priority: string) {
    // Optimistic update across both lists so the badge — and any active
    // priority sort — reflect the change immediately.
    const p = priority as Task["priority"];
    const apply = (list: Task[]) =>
      list.map((t) => (t.id === taskId ? { ...t, priority: p } : t));
    setTodayTasks(apply);
    setAllTasks(apply);
    setSearchResults((prev) => (prev ? apply(prev) : prev));
    setSelectedTask((prev) => (prev && prev.id === taskId ? { ...prev, priority: p } : prev));
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { priority } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
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
    const nowIso = new Date().toISOString();
    if (!task.seen_at) {
      setTodayTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, seen_at: nowIso } : t)));
      setAllTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, seen_at: nowIso } : t)));
      api(`/api/tasks/${task.id}/seen`, { method: "POST" }).catch(() => {});
    }
    // Reading the task clears its unread-update flag, so the "עדכון חדש"
    // banner disappears the moment the user opens it.
    if (task.has_unread_update) {
      setTodayTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, has_unread_update: false } : t)));
      setAllTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, has_unread_update: false } : t)));
      api(`/api/tasks/${task.id}`, { method: "PATCH", body: { has_unread_update: false } }).catch(() => {});
    }
    setSelectedTask({ ...task, seen_at: task.seen_at ?? nowIso, has_unread_update: false });
    setDetailOpen(true);
  }

  function handleQuickAction(taskId: string, action: { label: string; prompt: string }) {
    const task = [...todayTasks, ...allTasks].find((t) => t.id === taskId);
    setQaTaskId(taskId); setQaLabel(action.label); setQaPrompt(action.prompt);
    setQaSourceType(task?.source_messages?.source_type ?? null);
    setQaPhone(task?.related_contact_phone ?? null);
    setQaOpen(true);
  }

  function handleDriveSearch(taskId: string, description: string) {
    setDsTaskId(taskId); setDsDescription(description); setDsOpen(true);
  }

  // Move a task from All → Today (append to end of Today list)
  async function handleAddToToday(taskId: string) {
    const maxPos = todayTasks.reduce((m, t) => Math.max(m, t.today_position ?? -1), -1);
    const newPos = maxPos + 1;
    // Optimistic update
    const task = allTasks.find((t) => t.id === taskId);
    if (task) {
      setAllTasks((prev) => prev.filter((t) => t.id !== taskId));
      setTodayTasks((prev) => [...prev, { ...task, today_position: newPos }]);
    }
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { today_position: newPos } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  // Remove a task from Today → back to All
  async function handleRemoveFromToday(taskId: string) {
    const task = todayTasks.find((t) => t.id === taskId);
    if (task) {
      setTodayTasks((prev) => prev.filter((t) => t.id !== taskId));
      setAllTasks((prev) => [{ ...task, today_position: null as unknown as number }, ...prev]);
    }
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { today_position: null } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  // Drag end → recompute today_position for all Today tasks
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = todayTasks.findIndex((t) => t.id === active.id);
    const newIndex = todayTasks.findIndex((t) => t.id === over.id);
    const reordered = arrayMove(todayTasks, oldIndex, newIndex).map((t, i) => ({
      ...t,
      today_position: i,
    }));
    setTodayTasks(reordered);

    // Persist new positions
    await Promise.all(
      reordered.map((t) =>
        api(`/api/tasks/${t.id}`, { method: "PATCH", body: { today_position: t.today_position } }),
      ),
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Search results keep their relevance order. Otherwise apply the chosen
  // sort: by priority (urgent → low, tie-break newest first) or by date
  // (newest first — the API's default order).
  const sortedAll =
    allSort === "priority"
      ? [...allTasks].sort((a, b) => {
          const rank =
            (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99);
          if (rank !== 0) return rank;
          return (b.created_at ?? "").localeCompare(a.created_at ?? "");
        })
      : allTasks;
  const displayAll = searchResults !== null ? searchResults : sortedAll;

  return (
    <div className="space-y-6">
      <SmartSearch
        onResults={(results) => setSearchResults(results.length > 0 ? results : null)}
      />

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
        </div>
      ) : (
        <>
          {/* ── TODAY section ────────────────────────────────────────── */}
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              היום
            </h2>
            {todayTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {`גרור משימות מ"הכל" לכאן לתכנון יום העבודה`}
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={todayTasks.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-3">
                    {todayTasks.map((task) => (
                      <SortableTaskCard
                        key={task.id}
                        task={task}
                        locale={locale}
                        onSelect={handleSelect}
                        onComplete={handleComplete}
                        onSnooze={(id) => setSnoozeTaskId(id)}
                        onDelete={handleDelete}
                        onQuickAction={handleQuickAction}
                        onDriveSearch={handleDriveSearch}
                        onToggleToday={handleRemoveFromToday}
                        onPriorityChange={handlePriorityChange}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </section>

          {/* ── ALL section ──────────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                הכל
              </h2>
              {searchResults === null && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      title={t("sortBy.label")}
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" />
                      {allSort === "priority" ? t("sortBy.priority") : t("sortBy.date")}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={allSort}
                      onValueChange={(v) => changeAllSort(v as AllSort)}
                    >
                      <DropdownMenuRadioItem value="priority">
                        {t("sortBy.priority")}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="date">
                        {t("sortBy.date")}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {displayAll.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t("noTasksInView")}
              </p>
            ) : (
              <div className="space-y-3">
                {displayAll.map((task) => (
                  <div key={task.id} className="flex gap-2 items-start">
                    <div className="flex-1">
                      <TaskCard
                        task={task}
                        locale={locale}
                        onSelect={handleSelect}
                        onComplete={handleComplete}
                        onSnooze={(id) => setSnoozeTaskId(id)}
                        onDelete={handleDelete}
                        onQuickAction={handleQuickAction}
                        onDriveSearch={handleDriveSearch}
                        onToggleToday={handleAddToToday}
                        onPriorityChange={handlePriorityChange}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── COMPLETED section (collapsible) ──────────────────────── */}
          <section>
            <button
              className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 hover:text-foreground"
              onClick={() => {
                setShowCompleted((v) => {
                  if (!v) fetchCompleted();
                  return !v;
                });
              }}
            >
              {showCompleted ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              הושלמו
            </button>
            {showCompleted && (
              <div className="space-y-3">
                {completedTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center">{t("noTasksInView")}</p>
                ) : (
                  completedTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      locale={locale}
                      onSelect={handleSelect}
                      onComplete={handleComplete}
                      onSnooze={(id) => setSnoozeTaskId(id)}
                      onActivate={handleActivate}
                      onDelete={handleDelete}
                      onQuickAction={handleQuickAction}
                      onDriveSearch={handleDriveSearch}
                    />
                  ))
                )}
              </div>
            )}
          </section>
        </>
      )}

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

      <QuickAction
        taskId={qaTaskId}
        actionLabel={qaLabel}
        actionPrompt={qaPrompt}
        sourceType={qaSourceType}
        contactPhone={qaPhone}
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        onDone={fetchTasks}
      />

      <DriveSearch
        taskId={dsTaskId}
        taskDescription={dsDescription}
        open={dsOpen}
        onClose={() => setDsOpen(false)}
        onDone={fetchTasks}
      />

      <SnoozeDialog
        open={!!snoozeTaskId}
        onClose={() => setSnoozeTaskId(null)}
        onConfirm={handleSnoozeConfirm}
      />
    </div>
  );
}
