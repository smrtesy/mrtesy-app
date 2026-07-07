"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
import { TaskRow, type RowZone } from "./TaskRow";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { TaskDetail } from "./TaskDetail";
import { MarathonMode } from "./MarathonMode";
import { ReviewBanner } from "./ReviewBanner";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { SnoozeDialog } from "./SnoozeDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import {
  effectiveDeadline,
  dueUrgency,
  sittingWorkdays,
  autoSnoozeMoment,
  AGING_REVIEW_WORKDAYS,
} from "@/lib/workdays";
import { undoToast } from "@/components/ui/undo-toast";
import { dueLabel } from "./DueDateChip";
import { toast } from "sonner";
import { Zap, ChevronDown, ChevronUp, Play, Home, Briefcase, MapPin, GripVertical, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task, TaskNeed } from "@/types/task";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type ContextFilter = "all" | "home" | "office" | "outside";

/** Plan metadata (needs/blocked state) for MY plan tasks, keyed by task id. */
interface PlanMeta {
  needs: TaskNeed[];
}

/** Sortable wrapper for a desk row: grip handle + dnd-kit transform. */
function SortableDeskRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-center gap-1"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="shrink-0 touch-none cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground"
        aria-label="drag"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Identifiers for the four drop zones. A cross-list drop maps to the target
 *  list's (pinned, size) signature; see handleDragEnd. */
const LIST_QUICK = "list:desk-quick";
const LIST_REGULAR = "list:desk-regular";
const LIST_IMPORTANT = "list:important";
const LIST_WAITING = "list:waiting";

/** A list that is both a sortable context (reorder within) and a droppable
 *  target (so a row can be dragged in from another list, even when empty). */
function DroppableList({ id, items, children }: { id: string; items: string[]; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <SortableContext id={id} items={items} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="min-h-[2.5rem] space-y-1.5">{children}</div>
    </SortableContext>
  );
}

/**
 * The desk page — four lists, assigned in priority order (active = not blocked,
 * not snoozed; snoozed rows aren't fetched):
 *   מהיר – עכשיו / רגיל – עכשיו — manually pinned (today_position) tasks, split
 *               by size. Pinning wins: a task you put on the desk lives here
 *               even if its deadline is near.
 *   חשוב       — the radar: anything with an effective deadline within 3 working
 *               days, plus any regular task you haven't pinned and didn't give a
 *               far-off deadline (e.g. a regular task you just created).
 *   ממתינות   — the rest: unpinned quick tasks with no near deadline, regular
 *               tasks parked behind a far deadline, and blocked tasks.
 *   הושלמו    — collapsed, with reopen.
 */
export function TaskList({ locale, title }: { locale: string; title?: string }) {
  const t = useTranslations("tasks");
  const tNav = useTranslations("nav");
  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const blocked = useWorkCalendar();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [tasks, setTasks] = useState<Task[]>([]);
  const [planMeta, setPlanMeta] = useState<Map<string, PlanMeta>>(new Map());
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [contextFilter, setContextFilter] = useState<ContextFilter>("office");
  const [marathonMode, setMarathonMode] = useState<null | "quick" | "regular">(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);

  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hasLoadedRef = useRef(false);

  // ── optimistic-write reconciliation ─────────────────────────────────────────
  // A realtime change to ANY task triggers a full-list refetch ~400ms later
  // (see the subscription below). That refetch can race a write the user just
  // made — it reads the row *before* the PATCH commits — and `setTasks` then
  // clobbers the optimistic UI, so the task visibly "snaps back" for a moment.
  // We hold every optimistic edit/removal here and re-apply it on each refetch
  // until the server's own `updated_at` proves it has caught up (or a TTL
  // expires, so a dropped confirmation can never freeze the list).
  const pendingEditsRef = useRef<Map<string, { patch: Record<string, unknown>; confirmedAt: string | null; at: number }>>(new Map());
  const removedRef = useRef<Map<string, number>>(new Map());
  const PENDING_TTL_MS = 10_000;

  /** Overlay still-unconfirmed optimistic edits/removals onto a fresh server
   *  list so a refetch that raced a local write can't bounce it. */
  const reconcilePending = useCallback((rows: Task[]): Task[] => {
    const now = Date.now();
    for (const [id, pend] of pendingEditsRef.current) {
      if (now - pend.at > PENDING_TTL_MS) { pendingEditsRef.current.delete(id); continue; }
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) continue; // not in this list (e.g. completed) — removals handle it
      if (pend.confirmedAt && Date.parse(rows[idx].updated_at) >= Date.parse(pend.confirmedAt)) {
        pendingEditsRef.current.delete(id); // server reflects our write — let it through
      } else {
        rows[idx] = { ...rows[idx], ...(pend.patch as Partial<Task>) }; // keep our version
      }
    }
    if (removedRef.current.size) {
      for (const [id, at] of removedRef.current) {
        if (now - at > PENDING_TTL_MS) removedRef.current.delete(id);
      }
      rows = rows.filter((r) => !removedRef.current.has(r.id));
    }
    return rows;
  }, []);

  /** Optimistically drop a row (complete / snooze / auto-snooze) and remember it
   *  so a racing refetch can't resurrect it before the write commits. */
  const optimisticRemove = useCallback((taskId: string) => {
    pendingEditsRef.current.delete(taskId); // the row is leaving — no edit to re-apply
    removedRef.current.set(taskId, Date.now());
    setTasks((prev) => prev.filter((row) => row.id !== taskId));
  }, []);

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
      setTasks(reconcilePending(merged));
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
  }, [reconcilePending]);

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
    // Periodic safety-net refresh: Realtime can silently drop while a tab sits
    // in the background, so a desktop tab left open all day might miss updates
    // made from mobile. Poll every 10 minutes (only when the tab is visible),
    // and also refetch immediately when the tab regains focus.
    const handleVisibility = () => {
      if (!document.hidden) fetchTasks();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    const pollId = setInterval(() => {
      if (!document.hidden) fetchTasks();
    }, 10 * 60 * 1000);
    return () => {
      supabase.removeChannel(channel);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(pollId);
    };
  }, [fetchTasks, supabase]);

  // ── partition: desk / waiting ───────────────────────────────────────────────

  const unsatisfiedOf = useCallback((task: Task): TaskNeed[] => {
    const needs = planMeta.get(task.id)?.needs ?? task.needs ?? [];
    return needs.filter((n) => !n.satisfied);
  }, [planMeta]);

  /** Which of the four lists a task belongs to — the single source of truth for
   *  both the partition below and the drag-drop "will this drop stick?" check.
   *  Priority order: blocked → ממתינות; pinning wins; then the deadline radar;
   *  then unpinned regular tasks without a deadline; everything else waits. */
  const bucketOf = useCallback((task: Task): string => {
    if (unsatisfiedOf(task).length > 0) return LIST_WAITING;
    if (task.today_position != null) return task.size === "quick" ? LIST_QUICK : LIST_REGULAR;
    const deadline = effectiveDeadline(task);
    if (deadline && dueUrgency(deadline, blocked) !== "far") return LIST_IMPORTANT;
    if (task.size === "regular" && !deadline) return LIST_IMPORTANT;
    return LIST_WAITING;
  }, [unsatisfiedOf, blocked]);

  const { deskQuick, deskRegular, important, waiting, reviewCandidates } = useMemo(() => {
    const visible = tasks.filter((task) => {
      if (contextFilter === "home") return task.context === "home";
      if (contextFilter === "outside") return task.context === "outside";
      // Office is the quiet default: everything that isn't explicitly home/outside
      // (null or the legacy 'work' value).
      if (contextFilter === "office") return task.context !== "home" && task.context !== "outside";
      return true;
    });

    const quickList: Task[] = [];
    const regularList: Task[] = [];
    const importantList: Task[] = [];
    const waitingList: Task[] = [];
    for (const task of visible) {
      switch (bucketOf(task)) {
        case LIST_QUICK: quickList.push(task); break;
        case LIST_REGULAR: regularList.push(task); break;
        case LIST_IMPORTANT: importantList.push(task); break;
        default: waitingList.push(task);
      }
    }

    // Desk order: manual position ascending (all desk rows are pinned).
    const byPosition = (a: Task, b: Task) => (a.today_position ?? 0) - (b.today_position ?? 0);

    // ממתינות order: deadline asc (undated last), then priority, then newest.
    const byUrgency = (a: Task, b: Task) => {
      const da = effectiveDeadline(a);
      const db = effectiveDeadline(b);
      if (da && db && da !== db) return da.localeCompare(db);
      if (da && !db) return -1;
      if (!da && db) return 1;
      const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (rank !== 0) return rank;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    };
    // חשוב order: the unpinned regular pile (undated) on top, newest first — so a
    // freshly added regular task lands at the very head of חשוב — then the dated
    // near-deadline items below, soonest first.
    const byImportant = (a: Task, b: Task) => {
      const da = effectiveDeadline(a);
      const db = effectiveDeadline(b);
      if (!da && !db) return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      if (!da) return -1; // undated floats above dated
      if (!db) return 1;
      if (da !== db) return da.localeCompare(db);
      const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (rank !== 0) return rank;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    };
    const importantSorted = [...importantList].sort(byImportant);
    const waitingSorted = [...waitingList].sort(byUrgency);

    const review = waitingSorted.filter((task) => sittingWorkdays(task, blocked) >= AGING_REVIEW_WORKDAYS);

    return {
      deskQuick: [...quickList].sort(byPosition),
      deskRegular: [...regularList].sort(byPosition),
      important: importantSorted,
      waiting: waitingSorted,
      reviewCandidates: review,
    };
  }, [tasks, contextFilter, blocked, bucketOf]);

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
    // Optimistically drop the row so the ✓ feels instant; the API call +
    // realtime refetch reconcile, and on failure we refetch to restore.
    if (done) optimisticRemove(task.id);
    try {
      if (done) {
        await completeTask(task);
        undoToast({
          message: t("actions.complete"),
          undoLabel: t("row.undo"),
          onUndo: () => {
            removedRef.current.delete(task.id);
            reopenTask(task).then(fetchTasks).catch((e) => toast.error((e as Error).message));
          },
        });
      } else {
        await reopenTask(task);
        toast.success(t("row.reopened"));
      }
      fetchTasks();
      if (showCompleted) fetchCompleted();
    } catch (e) {
      removedRef.current.delete(task.id);
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  async function handleSnoozeConfirm(untilIso: string) {
    if (!snoozeTaskId) return;
    const id = snoozeTaskId;
    optimisticRemove(id);
    try {
      await api(`/api/tasks/${id}/snooze`, { method: "POST", body: { until: untilIso } });
      toast.success(t("actions.snooze"));
      fetchTasks();
    } catch (e) {
      removedRef.current.delete(id);
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  async function patchTask(taskId: string, body: Record<string, unknown>, optimistic?: (task: Task) => Task): Promise<boolean> {
    if (optimistic) {
      setTasks((prev) => prev.map((task) => (task.id === taskId ? optimistic(task) : task)));
      setSelectedTask((prev) => (prev && prev.id === taskId ? optimistic(prev) : prev));
    }
    // Hold the edit so a refetch racing this write can't bounce it back.
    pendingEditsRef.current.set(taskId, { patch: body, confirmedAt: null, at: Date.now() });
    try {
      const { task } = await api<{ task: Task }>(`/api/tasks/${taskId}`, { method: "PATCH", body });
      const pend = pendingEditsRef.current.get(taskId);
      if (pend && task?.updated_at) {
        pendingEditsRef.current.set(taskId, { ...pend, confirmedAt: task.updated_at, at: Date.now() });
      }
      return true;
    } catch (e) {
      pendingEditsRef.current.delete(taskId);
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
      return false;
    }
  }

  function handleSizeToggle(taskId: string, size: "quick" | "regular") {
    patchTask(taskId, { size }, (task) => ({ ...task, size }));
  }

  /** Pull a task back out of an (auto-)snooze: status→inbox, clear snoozed_until. */
  const unsnooze = useCallback((taskId: string) => {
    removedRef.current.delete(taskId); // bringing it back — let the refetch show it
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "inbox", snoozed_until: null } })
      .then(fetchTasks)
      .catch((e) => { toast.error((e as Error).message); fetchTasks(); });
  }, [fetchTasks]);

  async function handleDueChange(taskId: string, date: string | null) {
    // Persist the due date FIRST and wait for it: the snooze route below reads
    // due_date from the DB to clamp the wake moment to the deadline, so it must
    // see the value we just set (and we must not snooze if the date write failed).
    const ok = await patchTask(taskId, { due_date: date }, (task) => ({ ...task, due_date: date }));
    // Setting a due date auto-snoozes the item until two working days before it,
    // so it disappears from the desk/waiting lists now and resurfaces in time.
    // Skipped when there isn't enough lead time (autoSnoozeMoment → null).
    if (!ok || !date) return;
    const moment = autoSnoozeMoment(date, blocked);
    if (!moment) return;
    optimisticRemove(taskId); // optimistic hide until it resurfaces near the deadline
    api(`/api/tasks/${taskId}/snooze`, { method: "POST", body: { until: moment.iso } })
      .then(fetchTasks)
      .catch((e) => { removedRef.current.delete(taskId); toast.error((e as Error).message); fetchTasks(); });
    undoToast({
      message: t("undo.autoSnoozed", { date: dueLabel(moment.dateISO) }),
      undoLabel: t("row.undo"),
      onUndo: () => unsnooze(taskId),
      changeLabel: t("undo.changeDate"),
      onChange: () => setSnoozeTaskId(taskId),
    });
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

  // ── render ─────────────────────────────────────────────────────────────────

  const contextChips: { key: ContextFilter; label: string; icon?: typeof Home }[] = [
    { key: "all", label: t("contextFilter.all") },
    { key: "home", label: t("contextFilter.home"), icon: Home },
    { key: "office", label: t("contextFilter.office"), icon: Briefcase },
    { key: "outside", label: t("contextFilter.outside"), icon: MapPin },
  ];

  function renderRow(task: Task, zone: RowZone) {
    return (
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
    );
  }

  /** Persist a desk column's order: write today_position 0..n to `ids` in order,
   *  and (when a row is crossing in from another list) set its size. Optimistic
   *  + pending-reconciled so a racing refetch can't undo it. */
  async function applyDeskOrder(ids: string[], crossingId: string | null, crossingSize: "quick" | "regular" | null) {
    const posById = new Map(ids.map((id, i) => [id, i]));
    const bodyFor = (id: string): Record<string, unknown> => {
      const body: Record<string, unknown> = { today_position: posById.get(id)! };
      if (id === crossingId && crossingSize) body.size = crossingSize;
      return body;
    };
    setTasks((prev) =>
      prev.map((row) => (posById.has(row.id) ? { ...row, ...(bodyFor(row.id) as Partial<Task>) } : row)),
    );
    const now = Date.now();
    for (const id of ids) pendingEditsRef.current.set(id, { patch: bodyFor(id), confirmedAt: null, at: now });
    try {
      // One batch request for the whole column (previously one PATCH per row).
      const { tasks: saved } = await api<{ tasks: { id: string; updated_at: string | null }[] }>(
        "/api/tasks/reorder",
        { method: "PATCH", body: { items: ids.map((id) => ({ id, ...bodyFor(id) })) } },
      );
      for (const task of saved ?? []) {
        const pend = task?.id ? pendingEditsRef.current.get(task.id) : undefined;
        if (pend && task?.updated_at) {
          pendingEditsRef.current.set(task.id, { ...pend, confirmedAt: task.updated_at, at: Date.now() });
        }
      }
    } catch (e) {
      for (const id of ids) pendingEditsRef.current.delete(id);
      toast.error(e instanceof Error ? e.message : "Error");
      fetchTasks();
    }
  }

  /** Drag end — reorder within a desk column, or move a row to another list.
   *  Each list is defined by a (pinned, size) signature, so a cross-list drop is
   *  just a patch of today_position + size; the deadline radar still overrides
   *  (a near-deadline row always lands in חשוב when unpinned). */
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const lists: Record<string, Task[]> = {
      [LIST_QUICK]: deskQuick,
      [LIST_REGULAR]: deskRegular,
      [LIST_IMPORTANT]: important,
      [LIST_WAITING]: waiting,
    };
    const containerOf = (id: string | number): string | null => {
      const s = String(id);
      if (s.startsWith("list:")) return s;
      return Object.keys(lists).find((k) => lists[k].some((task) => task.id === s)) ?? null;
    };
    const from = containerOf(active.id);
    const to = containerOf(over.id);
    if (!from || !to) return;
    const isDesk = (k: string) => k === LIST_QUICK || k === LIST_REGULAR;
    const activeId = String(active.id);

    if (from === to) {
      // חשוב / ממתינות have no persistent manual order — only desk columns reorder.
      if (!isDesk(to) || active.id === over.id) return;
      const column = lists[to];
      const oldIndex = column.findIndex((row) => row.id === activeId);
      const newIndex = column.findIndex((row) => row.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      await applyDeskOrder(arrayMove(column, oldIndex, newIndex).map((row) => row.id), null, null);
      return;
    }

    // Cross-list move. A blocked task is forced to ממתינות by the partition, so
    // moving it elsewhere would just snap back — ignore the drop.
    const task = tasks.find((row) => row.id === activeId);
    if (!task || unsatisfiedOf(task).length > 0) return;

    if (isDesk(to)) {
      // Pinning wins over the deadline radar, so a desk drop always sticks.
      const size = to === LIST_QUICK ? "quick" : "regular";
      const column = lists[to];
      const overIdx = column.findIndex((row) => row.id === String(over.id));
      const insertAt = overIdx >= 0 ? overIdx : column.length;
      const ids = column.map((row) => row.id);
      ids.splice(insertAt, 0, activeId);
      await applyDeskOrder(ids, activeId, size);
      return;
    }

    // חשוב = unpinned regular (so the unpinned-regular rule holds it);
    // ממתינות = unpinned quick. But the deadline radar overrides both: a
    // near-deadline task always lands in חשוב, and a far-dated regular task
    // always lands in ממתינות. If this drop wouldn't stick, say so instead of
    // silently letting it bounce.
    const patch = to === LIST_IMPORTANT
      ? { today_position: null, size: "regular" as const }
      : { today_position: null, size: "quick" as const };
    if (bucketOf({ ...task, ...patch }) !== to) {
      toast.error(t("dndDeadlineLocked"));
      return;
    }
    patchTask(activeId, patch, (row) => ({ ...row, ...patch }));
  }

  /** One drop zone: sortable + droppable, with a grip per row. */
  function renderList(listId: string, list: Task[], zone: RowZone, emptyMsg: string) {
    return (
      <DroppableList id={listId} items={list.map((task) => task.id)}>
        {list.length === 0 ? (
          <p className="rounded-lg border border-dashed py-3 text-center text-xs text-muted-foreground">{emptyMsg}</p>
        ) : (
          list.map((task) => (
            <SortableDeskRow key={task.id} id={task.id}>
              {renderRow(task, zone)}
            </SortableDeskRow>
          ))
        )}
      </DroppableList>
    );
  }

  return (
    <>
    {/* Title + context filter — ABOVE the search row (which CombinedSearch
        renders right under this). */}
    <div className="mb-3 flex items-center gap-3">
      {title && <h1 className="text-2xl font-bold">{title}</h1>}
      {/* Quick jump to the source log. Inside a workspace pane this opens the
          log as its OWN tab rather than replacing the current pane. */}
      <OpenTabLink
        href={`/${locale}/log`}
        label={tNav("log")}
        aria-label={t("openLog")}
        title={t("openLog")}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLink className="h-4 w-4" />
      </OpenTabLink>
      <InstallAppButton />
      <div className="ms-auto flex rounded-lg border p-0.5">
        {contextChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setContextFilter(chip.key)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
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
    <CombinedSearch locale={locale} onUpdate={fetchTasks}>
    <div className="space-y-6">
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : (
        <>
          <ReviewBanner
            candidates={reviewCandidates}
            locale={locale}
            blocked={blocked}
            onChanged={fetchTasks}
            onSnooze={(id) => setSnoozeTaskId(id)}
          />

          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
          {/* ── ON THE DESK — quick stacked above regular (full width each,
                 so rows never get cramped) ──────────────────────────────── */}
          <section className="space-y-4">
            {/* Quick */}
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
                    onClick={() => setMarathonMode("quick")}
                  >
                    <Play className="h-3 w-3" />
                    {t("desk.startRun")}
                  </Button>
                )}
              </div>
              {renderList(LIST_QUICK, deskQuick, "desk", t("desk.emptyQuick"))}
            </div>

            {/* Regular — same run feature as the quick column */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("desk.regular")}
                  <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskRegular.length}</span>
                </h2>
                {deskRegular.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-auto h-7 gap-1 text-xs"
                    onClick={() => setMarathonMode("regular")}
                  >
                    <Play className="h-3 w-3" />
                    {t("desk.startRun")}
                  </Button>
                )}
              </div>
              {renderList(LIST_REGULAR, deskRegular, "desk", t("desk.emptyRegular"))}
            </div>
          </section>

          {/* ── IMPORTANT (חשוב) — deadline radar + the unpinned regular pile ── */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t("desk.important")}
              <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{important.length}</span>
            </h2>
            {renderList(LIST_IMPORTANT, important, "important", t("desk.emptyImportant"))}
          </section>

          {/* ── WAITING ──────────────────────────────────────────────── */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {t("desk.waiting")}
              <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{waiting.length}</span>
            </h2>
            {renderList(LIST_WAITING, waiting, "waiting", t("noTasksInView"))}
          </section>
          </DndContext>

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

      {marathonMode && (
        <MarathonMode
          key={marathonMode}
          tasks={marathonMode === "quick" ? deskQuick : deskRegular}
          locale={locale}
          mode={marathonMode}
          onComplete={async (taskId) => {
            const task = tasks.find((row) => row.id === taskId);
            if (task) await completeTask(task);
            fetchTasks();
          }}
          onReclassify={async (taskId) => {
            // "Wrong column" — flip to the OTHER size and drop from this run.
            await api(`/api/tasks/${taskId}`, {
              method: "PATCH",
              body: { size: marathonMode === "quick" ? "regular" : "quick" },
            });
            fetchTasks();
          }}
          onExit={() => { setMarathonMode(null); fetchTasks(); }}
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
      />
    </>
  );
}
