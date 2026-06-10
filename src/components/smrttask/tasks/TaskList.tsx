"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api, ApiError } from "@/lib/api/client";
import { TaskRow } from "./TaskRow";
import { TaskDetail } from "./TaskDetail";
import { MarathonMode } from "./MarathonMode";
import { ReviewBanner } from "./ReviewBanner";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { SnoozeDialog } from "./SnoozeDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import {
  effectiveDeadline,
  dueUrgency,
  sittingWorkdays,
  AGING_REVIEW_WORKDAYS,
} from "@/lib/workdays";
import { toast } from "sonner";
import { Zap, ChevronDown, ChevronUp, Play, Home, Briefcase } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task, TaskNeed } from "@/types/task";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type ContextFilter = "all" | "home" | "work";

/** Plan metadata (needs/blocked state) for MY plan tasks, keyed by task id. */
interface PlanMeta {
  needs: TaskNeed[];
}

/**
 * The desk page:
 *   על השולחן — two columns (⚡ quick | regular): manually pinned tasks
 *               (today_position) + auto-promoted ones (effective deadline
 *               within 3 working days and not blocked).
 *   ממתינות   — everything else, sorted by deadline urgency (undated last).
 *   הושלמו    — collapsed, with reopen.
 */
export function TaskList({ locale }: { locale: string }) {
  const t = useTranslations("tasks");
  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const blocked = useWorkCalendar();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [planMeta, setPlanMeta] = useState<Map<string, PlanMeta>>(new Map());
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [contextFilter, setContextFilter] = useState<ContextFilter>("all");
  const [marathonOpen, setMarathonOpen] = useState(false);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);

  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hasLoadedRef = useRef(false);

  // QuickAction / DriveSearch state (opened from TaskDetail)
  const [qaOpen, setQaOpen] = useState(false);
  const [qaTaskId, setQaTaskId] = useState("");
  const [qaLabel, setQaLabel] = useState("");
  const [qaPrompt, setQaPrompt] = useState("");
  const [qaSourceType, setQaSourceType] = useState<string | null>(null);
  const [qaPhone, setQaPhone] = useState<string | null>(null);
  const [dsOpen, setDsOpen] = useState(false);
  const [dsTaskId, setDsTaskId] = useState("");
  const [dsDescription, setDsDescription] = useState("");

  const fetchTasks = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const activeStatuses = "inbox,in_progress,pending_completion";
      const [{ tasks: rows }, planRes] = await Promise.all([
        api<{ tasks: Task[] }>(`/api/tasks?status=${activeStatuses}&verified=true&limit=200`),
        // MY plan tasks: merged in as desk rows (plan tasks are never
        // manually_verified, so the org list above doesn't include them) and
        // the source of blocked-state meta. smrtPlan may not be enabled for
        // this org — that's fine, the desk just has no plan rows.
        api<{ tasks: (Task & { needs?: TaskNeed[] })[] }>("/api/plan/my-tasks").catch(() => ({ tasks: [] })),
      ]);
      const merged: Task[] = [...(rows ?? [])];
      const present = new Set(merged.map((row) => row.id));
      const meta = new Map<string, PlanMeta>();
      const OPEN = new Set(["inbox", "in_progress", "pending_completion"]);
      for (const pt of planRes.tasks ?? []) {
        meta.set(pt.id, { needs: pt.needs ?? [] });
        if (!present.has(pt.id) && OPEN.has(pt.status)) merged.push(pt as Task);
      }
      setTasks(merged);
      setPlanMeta(meta);
      hasLoadedRef.current = true;
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
      const { tasks: rows } = await api<{ tasks: Task[] }>(`/api/tasks?status=archived,completed&limit=50`);
      setCompletedTasks(rows ?? []);
    } catch {
      // non-fatal
    }
  }, []);

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

  // ── partition: desk / waiting ───────────────────────────────────────────────

  const unsatisfiedOf = useCallback((task: Task): TaskNeed[] => {
    const needs = planMeta.get(task.id)?.needs ?? task.needs ?? [];
    return needs.filter((n) => !n.satisfied);
  }, [planMeta]);

  const { deskQuick, deskRegular, waiting, reviewCandidates } = useMemo(() => {
    const visible = tasks.filter((task) => {
      if (contextFilter === "home") return task.context === "home";
      if (contextFilter === "work") return task.context !== "home";
      return true;
    });

    const desk: Task[] = [];
    const waitingList: Task[] = [];
    for (const task of visible) {
      const isBlocked = unsatisfiedOf(task).length > 0;
      const deadline = effectiveDeadline(task);
      const nearDeadline = !!deadline && dueUrgency(deadline, blocked) !== "far";
      const pinned = task.today_position != null;
      if (!isBlocked && (pinned || nearDeadline)) desk.push(task);
      else waitingList.push(task);
    }

    // Desk order: pinned first by manual position, then auto-promoted by deadline.
    const deskSorted = [...desk].sort((a, b) => {
      const ap = a.today_position;
      const bp = b.today_position;
      if (ap != null && bp != null) return ap - bp;
      if (ap != null) return -1;
      if (bp != null) return 1;
      const da = effectiveDeadline(a) ?? "9999";
      const db = effectiveDeadline(b) ?? "9999";
      return da.localeCompare(db);
    });

    // Waiting order: deadline asc (undated last), then priority, then newest.
    const waitingSorted = [...waitingList].sort((a, b) => {
      const da = effectiveDeadline(a);
      const db = effectiveDeadline(b);
      if (da && db && da !== db) return da.localeCompare(db);
      if (da && !db) return -1;
      if (!da && db) return 1;
      const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (rank !== 0) return rank;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });

    const review = waitingSorted.filter((task) => sittingWorkdays(task, blocked) >= AGING_REVIEW_WORKDAYS);

    return {
      deskQuick: deskSorted.filter((task) => task.size === "quick"),
      deskRegular: deskSorted.filter((task) => task.size !== "quick"),
      waiting: waitingSorted,
      reviewCandidates: review,
    };
  }, [tasks, contextFilter, blocked, unsatisfiedOf]);

  // Open focused task detail after load (deep links: ?focus=<id>)
  useEffect(() => {
    if (!focusId || loading) return;
    if (focusedRef.current === focusId) return;
    const match = tasks.find((task) => task.id === focusId);
    if (!match) return;
    focusedRef.current = focusId;
    setSelectedTask(match);
    setDetailOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [focusId, loading, tasks, pathname, router, searchParams]);

  // ── actions ────────────────────────────────────────────────────────────────

  const completeTask = useCallback(async (task: Task) => {
    if (task.plan_id) {
      await api(`/api/plan-tasks/${task.id}/done`, { method: "PATCH", body: { done: true } });
    } else {
      await api(`/api/tasks/${task.id}/complete`, { method: "POST" });
    }
  }, []);

  const reopenTask = useCallback(async (task: Task) => {
    if (task.plan_id) {
      await api(`/api/plan-tasks/${task.id}/done`, { method: "PATCH", body: { done: false } });
    } else {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "inbox" } });
    }
  }, []);

  async function handleToggleDone(task: Task, done: boolean) {
    try {
      if (done) {
        await completeTask(task);
        toast.success(t("actions.complete"), {
          action: {
            label: t("row.undo"),
            onClick: () => { reopenTask(task).then(fetchTasks).catch((e) => toast.error((e as Error).message)); },
          },
        });
      } else {
        await reopenTask(task);
        toast.success(t("row.reopened"));
      }
      fetchTasks();
      if (showCompleted) fetchCompleted();
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

  async function patchTask(taskId: string, body: Record<string, unknown>, optimistic?: (task: Task) => Task) {
    if (optimistic) {
      setTasks((prev) => prev.map((task) => (task.id === taskId ? optimistic(task) : task)));
      setSelectedTask((prev) => (prev && prev.id === taskId ? optimistic(prev) : prev));
    }
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  function handleSizeToggle(taskId: string, size: "quick" | "regular") {
    patchTask(taskId, { size }, (task) => ({ ...task, size }));
  }

  function handleDueChange(taskId: string, date: string | null) {
    patchTask(taskId, { due_date: date }, (task) => ({ ...task, due_date: date }));
  }

  function handleMove(taskId: string, toDesk: boolean) {
    if (toDesk) {
      const maxPos = tasks.reduce((m, task) => Math.max(m, task.today_position ?? -1), -1);
      patchTask(taskId, { today_position: maxPos + 1 }, (task) => ({ ...task, today_position: maxPos + 1 }));
    } else {
      patchTask(taskId, { today_position: null }, (task) => ({ ...task, today_position: null }));
    }
  }

  function handleDelete(taskId: string) {
    if (!window.confirm(t("actions.deleteConfirm"))) return;
    api(`/api/tasks/${taskId}`, { method: "DELETE" })
      .then(() => {
        toast.success(t("actions.deleted"));
        setDetailOpen(false);
        fetchTasks();
      })
      .catch((e) => toast.error((e as Error).message));
  }

  function handleSelect(task: Task) {
    const nowIso = new Date().toISOString();
    if (!task.seen_at || task.woke_from_snooze_at) {
      setTasks((prev) => prev.map((row) => (row.id === task.id ? { ...row, seen_at: row.seen_at ?? nowIso, woke_from_snooze_at: null } : row)));
      api(`/api/tasks/${task.id}/seen`, { method: "POST" }).catch(() => {});
    }
    if (task.has_unread_update) {
      setTasks((prev) => prev.map((row) => (row.id === task.id ? { ...row, has_unread_update: false } : row)));
      api(`/api/tasks/${task.id}`, { method: "PATCH", body: { has_unread_update: false } }).catch(() => {});
    }
    setSelectedTask({ ...task, seen_at: task.seen_at ?? nowIso, has_unread_update: false, woke_from_snooze_at: null });
    setDetailOpen(true);
  }

  function handleQuickAction(taskId: string, action: { label: string; prompt: string }) {
    const task = tasks.find((row) => row.id === taskId);
    setQaTaskId(taskId); setQaLabel(action.label); setQaPrompt(action.prompt);
    setQaSourceType(task?.source_messages?.source_type ?? null);
    setQaPhone(task?.related_contact_phone ?? null);
    setQaOpen(true);
  }

  function handleDriveSearch(taskId: string, description: string) {
    setDsTaskId(taskId); setDsDescription(description); setDsOpen(true);
  }

  const snoozeTask = snoozeTaskId ? tasks.find((task) => task.id === snoozeTaskId) : null;

  // ── render ─────────────────────────────────────────────────────────────────

  const contextChips: { key: ContextFilter; label: string; icon?: typeof Home }[] = [
    { key: "all", label: t("contextFilter.all") },
    { key: "home", label: t("contextFilter.home"), icon: Home },
    { key: "work", label: t("contextFilter.work"), icon: Briefcase },
  ];

  function renderRows(list: Task[], zone: "desk" | "waiting") {
    return list.map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        locale={locale}
        zone={zone}
        blocked={blocked}
        unsatisfiedNeeds={unsatisfiedOf(task)}
        autoPromoted={zone === "desk" && task.today_position == null}
        onToggleDone={handleToggleDone}
        onOpen={handleSelect}
        onSnooze={(id) => setSnoozeTaskId(id)}
        onMove={handleMove}
        onSizeToggle={handleSizeToggle}
        onDueChange={task.plan_id ? undefined : handleDueChange}
      />
    ));
  }

  return (
    <>
    <CombinedSearch locale={locale} onUpdate={fetchTasks}>
    <div className="space-y-6">
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : (
        <>
          {/* Context filter + review banner */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-lg border p-0.5">
              {contextChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setContextFilter(chip.key)}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    contextFilter === chip.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {chip.icon && <chip.icon className="h-3 w-3" />}
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          <ReviewBanner
            candidates={reviewCandidates}
            locale={locale}
            blocked={blocked}
            onChanged={fetchTasks}
            onSnooze={(id) => setSnoozeTaskId(id)}
          />

          {/* ── ON THE DESK ──────────────────────────────────────────── */}
          <section>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Quick column */}
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="flex items-center gap-1 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    <Zap className="h-3.5 w-3.5 text-status-warn" />
                    {t("desk.quick")}
                    <span className="rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskQuick.length}</span>
                  </h2>
                  {deskQuick.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ms-auto h-7 gap-1 text-xs"
                      onClick={() => setMarathonOpen(true)}
                    >
                      <Play className="h-3 w-3" />
                      {t("desk.startRun")}
                    </Button>
                  )}
                </div>
                {deskQuick.length === 0 ? (
                  <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                    {t("desk.emptyQuick")}
                  </p>
                ) : (
                  <div className="space-y-2">{renderRows(deskQuick, "desk")}</div>
                )}
              </div>

              {/* Regular column */}
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("desk.regular")}
                    <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskRegular.length}</span>
                  </h2>
                </div>
                {deskRegular.length === 0 ? (
                  <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                    {t("desk.emptyRegular")}
                  </p>
                ) : (
                  <div className="space-y-2">{renderRows(deskRegular, "desk")}</div>
                )}
              </div>
            </div>
          </section>

          {/* ── WAITING ──────────────────────────────────────────────── */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t("desk.waiting")}
              <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{waiting.length}</span>
            </h2>
            {waiting.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t("noTasksInView")}</p>
            ) : (
              <div className="space-y-2">{renderRows(waiting, "waiting")}</div>
            )}
          </section>

          {/* ── COMPLETED (collapsible) ──────────────────────────────── */}
          <section>
            <button
              className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground"
              onClick={() => {
                setShowCompleted((v) => {
                  if (!v) fetchCompleted();
                  return !v;
                });
              }}
            >
              {showCompleted ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {t("desk.completed")}
            </button>
            {showCompleted && (
              <div className="space-y-2">
                {completedTasks.length === 0 ? (
                  <p className="py-2 text-center text-sm text-muted-foreground">{t("noTasksInView")}</p>
                ) : (
                  completedTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      locale={locale}
                      zone="done"
                      blocked={blocked}
                      onToggleDone={handleToggleDone}
                      onOpen={handleSelect}
                    />
                  ))
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
    </CombinedSearch>

      {marathonOpen && (
        <MarathonMode
          tasks={deskQuick}
          locale={locale}
          onComplete={async (taskId) => {
            const task = tasks.find((row) => row.id === taskId);
            if (task) await completeTask(task);
            fetchTasks();
          }}
          onMakeRegular={async (taskId) => {
            await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { size: "regular" } });
            fetchTasks();
          }}
          onExit={() => { setMarathonOpen(false); fetchTasks(); }}
        />
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
        maxDate={snoozeTask ? effectiveDeadline(snoozeTask) : null}
      />
    </>
  );
}
