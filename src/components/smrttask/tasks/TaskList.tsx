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
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api/client";
import { TaskRow, type RowZone } from "./TaskRow";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { TaskDetail } from "./TaskDetail";
import { MarathonMode } from "./MarathonMode";
import { FocusSession } from "./FocusSession";
import { ReviewBanner } from "./ReviewBanner";
import { BuildDayBanner } from "./BuildDayBanner";
import { DecisionDialog } from "./DecisionDialog";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { QuickAction } from "./QuickAction";
import { DriveSearch } from "./DriveSearch";
import { SnoozeDialog } from "./SnoozeDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { useDayTool } from "@/hooks/useDayTools";
import {
  sittingWorkdays,
  autoSnoozeMoment,
  eventReminderMoment,
  todayISO,
  effectiveDeadline,
  dueUrgency,
  AGING_REVIEW_WORKDAYS,
} from "@/lib/workdays";
import { undoToast } from "@/components/ui/undo-toast";
import { dueLabel } from "./DueDateChip";
import { toast } from "sonner";
import { Zap, ChevronDown, ChevronUp, Play, Home, Briefcase, MapPin, GripVertical, ExternalLink, Sun, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task, TaskNeed } from "@/types/task";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type ContextFilter = "all" | "home" | "office" | "outside";

/** Plan metadata (needs/blocked state) for MY plan tasks, keyed by task id. */
interface PlanMeta {
  needs: TaskNeed[];
}

/** One active plan-focus commitment for today (GET /plan/focus-today). */
interface FocusTodayPlan {
  plan_id: string;
  plan_title_he: string | null;
  plan_title_en: string | null;
  daily_minutes: number;
  current_stage: { id: string; title: string; title_he: string | null } | null;
  logged_today: boolean;
  completed_today: boolean;
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

/** Drop zones on the daily "היום" screen. Drag only reorders WITHIN a list
 *  (today_position); moving a task in/out of Today is done with the +/− button
 *  (planned_for) or the build-day banner, not drag. */
const LIST_QUICK = "list:today-quick";     // all quick tasks (do them all today)
// method131 ON — the 4-list day structure (§3.3): quick / medium-picked /
// big-picked / the rest.
const LIST_MEDIUM = "list:today-medium";   // medium picked for today
const LIST_BIG = "list:today-big";         // big picked for today
// method131 OFF — the original spec (§1): quick / regular-surfaced / waiting.
// (The collapsed rest/waiting pile renders as flat rows, not a droppable list,
// so only the orderable Today lists need a drop-zone id.)
const LIST_REGULAR = "list:today-regular"; // regular tasks a near deadline pulls onto the desk

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
 * The desk page — every active task is on the desk (active = not snoozed;
 * snoozed rows aren't fetched). A task leaves only by being completed or
 * dismissed — there is no ממתינות holding pile. Three lists by nature:
 *   מהיר – עכשיו — every quick task (size==="quick").
 *   רגיל – עכשיו — every regular task, except those a near deadline pulls into חשוב.
 *   חשוב         — the deadline radar: regular tasks with an effective deadline
 *                  within 3 working days.
 *   הושלמו       — collapsed, with reopen.
 * (today_position now only orders rows within מהיר / רגיל; snooze is the
 * deliberate "not now" path that hides a task until it should resurface.)
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
  const [showPool, setShowPool] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [contextFilter, setContextFilter] = useState<ContextFilter>("office");
  const [marathonMode, setMarathonMode] = useState<null | "quick" | "regular">(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);
  const [decisionTask, setDecisionTask] = useState<Task | null>(null);
  const [buildDayOpen, setBuildDayOpen] = useState(false);
  // Plan-focus day-tool: the daily focus block over a smrtPlan plan (default off).
  const planfocusEnabled = useDayTool("planfocus").enabled;
  const [focusPlans, setFocusPlans] = useState<FocusTodayPlan[]>([]);
  const [focusRun, setFocusRun] = useState<FocusTodayPlan | null>(null);
  // Day-tool: the marathon run is a toggleable add-on (default on).
  const marathonEnabled = useDayTool("marathon").enabled;
  // Day-tool: מהיר·3·1 gates the whole desk shape. ON → the 4-list day method
  // (quick / medium / big / rest) with soft quotas + the build-day banner.
  // OFF → the original spec: quick + a deadline-driven regular desk + waiting.
  const method131 = useDayTool("method131");
  const m131Enabled = method131.enabled;
  const mediumQuota = typeof method131.config.medium_quota === "number" ? method131.config.medium_quota : 3;
  const bigQuota = typeof method131.config.big_quota === "number" ? method131.config.big_quota : 1;

  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hasLoadedRef = useRef(false);

  // ── desk cache (React Query pilot) ──────────────────────────────────────────
  // The query cache outlives this component (gcTime in QueryProvider), so a
  // navigation away and back paints the last desk instantly instead of a
  // skeleton, while the normal fetch below revalidates in the background. The
  // cache is a paint-only layer: all fetching, realtime and optimistic logic
  // below is unchanged and remains the source of truth.
  const queryClient = useQueryClient();
  // Key includes the active org (subdomain cookie wins, then localStorage —
  // same precedence as api()'s X-Org-Id) so a multi-org user switching orgs
  // never gets a paint of the previous org's desk.
  const DESK_CACHE_KEY = useMemo(() => {
    let org = "default";
    if (typeof document !== "undefined") {
      const m = document.cookie.match(/(?:^|;\s*)smrt_org_id=([^;]+)(?:;|$)/);
      org = m ? decodeURIComponent(m[1]) : localStorage.getItem("smrtesy.active_org_id") ?? "default";
    }
    return ["smrttask", "desk", org] as const;
  }, []);
  type DeskCache = { merged: Task[]; meta: Map<string, PlanMeta> };

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
    // Mirror into the desk cache — removedRef dies with this mount, so without
    // this a remount within the refetch window would flash the removed row.
    queryClient.setQueryData<DeskCache>(DESK_CACHE_KEY, (d) =>
      d && { ...d, merged: d.merged.filter((row) => row.id !== taskId) });
  }, [queryClient, DESK_CACHE_KEY]);

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
      // Cache the server truth BEFORE reconcilePending bakes optimistic
      // patches into the array's elements (it assigns rows[idx] in place).
      queryClient.setQueryData<DeskCache>(DESK_CACHE_KEY, { merged: [...merged], meta });
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
  }, [reconcilePending, queryClient, DESK_CACHE_KEY]);

  // Paint the last known desk immediately on mount (see DESK_CACHE_KEY above).
  // The mount effect below still runs fetchTasks, which overwrites this with
  // fresh data as soon as it lands.
  useEffect(() => {
    if (hasLoadedRef.current) return;
    const cached = queryClient.getQueryData<DeskCache>(DESK_CACHE_KEY);
    if (cached) {
      setTasks(reconcilePending([...cached.merged]));
      setPlanMeta(cached.meta);
      setLoading(false);
      // Mark loaded so the mount fetch below revalidates in the background
      // instead of re-raising the skeleton (its first line checks this ref).
      hasLoadedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCompleted = useCallback(async () => {
    try {
      const { tasks: rows } = await api<{ tasks: Task[] }>(`/api/tasks?status=archived,completed&limit=50`);
      setCompletedTasks(rows ?? []);
    } catch {
      // non-fatal
    }
  }, []);

  // Plan-focus blocks for today — only when the tool is on (and smrtPlan is
  // enabled for the org; a 4xx just yields an empty list). Refetched alongside
  // the desk so ticking a stage inside a session updates the block on return.
  const fetchFocusToday = useCallback(async () => {
    if (!planfocusEnabled) { setFocusPlans([]); return; }
    try {
      const { plans } = await api<{ plans: FocusTodayPlan[] }>("/api/plan/focus-today");
      setFocusPlans(plans ?? []);
    } catch {
      setFocusPlans([]);
    }
  }, [planfocusEnabled]);

  useEffect(() => { fetchFocusToday(); }, [fetchFocusToday]);

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

  // ── partition: desk lists (mode-aware) ──────────────────────────────────────

  const unsatisfiedOf = useCallback((task: Task): TaskNeed[] => {
    const needs = planMeta.get(task.id)?.needs ?? task.needs ?? [];
    return needs.filter((n) => !n.satisfied);
  }, [planMeta]);

  // Today's local date — the anchor for planned_for ("היום").
  const todayStr = todayISO();

  /** True when a task should never surface on the desk regardless of mode:
   *  a future-dated task (surfaced later by the inbox's scheduled track) or a
   *  plan task that hasn't been explicitly picked for today (plan tasks flow
   *  through the inbox and live on their own board — spec: פלאן נכנסות דרך הנכנס).
   *  A task planned_for today is always eligible and never hidden. A task that
   *  just woke from snooze is demanding attention NOW (the auto-snooze deadline
   *  reminder wakes it ~2 working days before its still-future due date) — it
   *  must NOT be hidden by that future date, mirroring the pre-refactor order
   *  where the woke check preceded the future-date hide. */
  const isHidden = useCallback((task: Task): boolean => {
    if (task.planned_for === todayStr) return false;
    if (task.plan_id) return true;
    if (task.due_date && task.due_date > todayStr && !task.woke_from_snooze_at) return true;
    return false;
  }, [todayStr]);

  const {
    deskQuick, deskMedium, deskBig, rest, deskRegular, waiting, reviewCandidates,
  } = useMemo(() => {
    const visible = tasks.filter((task) => {
      if (contextFilter === "home") return task.context === "home";
      if (contextFilter === "outside") return task.context === "outside";
      // Office is the quiet default: everything that isn't explicitly home/outside
      // (null or the legacy 'work' value).
      if (contextFilter === "office") return task.context !== "home" && task.context !== "outside";
      return true;
    });

    const quickList: Task[] = [];
    const mediumPicked: Task[] = [];  // method131 ON
    const bigPicked: Task[] = [];     // method131 ON
    const restList: Task[] = [];      // method131 ON — the catch-all
    const regularDesk: Task[] = [];   // method131 OFF — deadline-surfaced
    const waitingList: Task[] = [];   // method131 OFF — the rest

    for (const task of visible) {
      if (task.size === "quick") { quickList.push(task); continue; }
      if (isHidden(task)) continue;
      const pickedToday = task.planned_for === todayStr;

      if (m131Enabled) {
        // 4-list method: medium/big picked for today — OR freshly woken from
        // snooze (the deadline reminder must stay visible, not sink into the
        // collapsed rest) — go to their list; everything else (undated,
        // overdue-not-picked) lands in the collapsed rest.
        const surfaced = pickedToday || !!task.woke_from_snooze_at;
        if (surfaced) (task.size === "big" ? bigPicked : mediumPicked).push(task);
        else restList.push(task);
      } else {
        // Off mode (original spec §1): a regular task rises to the desk when its
        // effective deadline is within DESK_HORIZON_WORKDAYS working days AND it
        // is not blocked; a task freshly woken from snooze also surfaces. Note
        // planned_for is intentionally ignored here (§3.2: it isn't deleted, it
        // just doesn't drive the display when the tool is off). The rest wait.
        const dl = effectiveDeadline(task);
        const notBlocked = unsatisfiedOf(task).length === 0;
        const near = !!dl && notBlocked && dueUrgency(dl, blocked) !== "far";
        if (near || task.woke_from_snooze_at) regularDesk.push(task);
        else waitingList.push(task);
      }
    }

    // Today order: manual position ascending (drag-reorder within a list).
    const byPosition = (a: Task, b: Task) => (a.today_position ?? 0) - (b.today_position ?? 0);
    // Priority, then newest — a plain worst-first fallback.
    const byPriority = (a: Task, b: Task) => {
      const rank = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (rank !== 0) return rank;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    };
    // Effective deadline ascending, nulls last — the "by date" order.
    const byDeadline = (a: Task, b: Task) => {
      const da = effectiveDeadline(a);
      const db_ = effectiveDeadline(b);
      if (da && db_) return da < db_ ? -1 : da > db_ ? 1 : byPriority(a, b);
      if (da) return -1;
      if (db_) return 1;
      return byPriority(a, b);
    };
    // The rest (§3.3): effective deadline → yesterday's fall → tenure → priority.
    const byRest = (a: Task, b: Task) => {
      const da = effectiveDeadline(a);
      const db_ = effectiveDeadline(b);
      if (da && db_ && da !== db_) return da < db_ ? -1 : 1;
      if (da && !db_) return -1;
      if (!da && db_) return 1;
      // "Fell from a previous day" — a stale pick that rolled over — ranks up.
      const fa = a.planned_for && a.planned_for < todayStr ? 0 : 1;
      const fb = b.planned_for && b.planned_for < todayStr ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const sa = sittingWorkdays(a, blocked);
      const sb = sittingWorkdays(b, blocked);
      if (sa !== sb) return sb - sa;
      return byPriority(a, b);
    };

    // Review banner drains the collapsed catch-all (rest / waiting) of stale rows.
    const catchAll = m131Enabled ? restList : waitingList;
    const review = catchAll.filter((task) => sittingWorkdays(task, blocked) >= AGING_REVIEW_WORKDAYS);

    return {
      deskQuick: [...quickList].sort(byPosition),
      deskMedium: [...mediumPicked].sort(byPosition),
      deskBig: [...bigPicked].sort(byPosition),
      rest: [...restList].sort(byRest),
      deskRegular: [...regularDesk].sort(byDeadline),
      waiting: [...waitingList].sort(byDeadline),
      reviewCandidates: review,
    };
  }, [tasks, contextFilter, blocked, isHidden, m131Enabled, unsatisfiedOf, todayStr]);

  // Soft daily quota (method131 ON): only DELIBERATE picks (planned_for today)
  // count — a task auto-surfaced by waking from snooze shows in the list but
  // must not inflate the quota or read as "picked" in the build-day picker.
  const pickedMedium = deskMedium.filter((task) => task.planned_for === todayStr).length;
  const pickedBig = deskBig.filter((task) => task.planned_for === todayStr).length;
  // The set planned_for today — drives the build-day picker's selected state.
  const pickedIds = useMemo(
    () => new Set(
      [...deskMedium, ...deskBig].filter((task) => task.planned_for === todayStr).map((task) => task.id),
    ),
    [deskMedium, deskBig, todayStr],
  );
  // Marathon "regular" run set: the picked medium+big (ON) or the surfaced
  // regular desk (OFF). Quick keeps its own run.
  const marathonRegularTasks = useMemo(
    () => (m131Enabled ? [...deskMedium, ...deskBig] : deskRegular),
    [m131Enabled, deskMedium, deskBig, deskRegular],
  );

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

  const completeTask = useCallback(async (task: Task, decision?: string) => {
    if (task.plan_id) {
      await api(`/api/plan-tasks/${task.id}/done`, {
        method: "PATCH",
        body: { done: true, ...(decision ? { decision } : {}) },
      });
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
    // A decision plan task first asks for its outcome (which propagates to the
    // tasks it affects); the actual completion runs on the dialog's confirm.
    if (done && task.plan_id && task.is_decision) {
      setDecisionTask(task);
      return;
    }
    await runToggleDone(task, done);
  }

  async function runToggleDone(task: Task, done: boolean, decision?: string) {
    // Optimistically drop the row so the ✓ feels instant; the API call +
    // realtime refetch reconcile, and on failure we refetch to restore.
    if (done) optimisticRemove(task.id);
    try {
      if (done) {
        await completeTask(task, decision);
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
      // Mirror into the desk cache so a remount mid-write paints the edited
      // row, not the pre-edit one (pendingEditsRef dies with this mount).
      queryClient.setQueryData<DeskCache>(DESK_CACHE_KEY, (d) =>
        d && { ...d, merged: d.merged.map((row) => (row.id === taskId ? optimistic(row) : row)) });
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

  function handleSizeToggle(taskId: string, size: "quick" | "medium" | "big") {
    // Marking a task "quick" (⚡) means "do it now" — pin it onto the desk's
    // מהיר – עכשיו section so it surfaces there by default instead of being
    // left in ממתינות. (Switching back to regular only changes the size; the
    // desk position, if any, is kept so it moves to רגיל – עכשיו.)
    if (size === "quick") {
      const maxPos = tasks.reduce((m, task) => Math.max(m, task.today_position ?? -1), -1);
      const patch = { size, today_position: maxPos + 1 };
      patchTask(taskId, patch, (task) => ({ ...task, ...patch }));
    } else {
      patchTask(taskId, { size }, (task) => ({ ...task, size }));
    }
  }

  /** Pull a task back out of an (auto-)snooze: status→inbox, clear snoozed_until. */
  const unsnooze = useCallback((taskId: string) => {
    removedRef.current.delete(taskId); // bringing it back — let the refetch show it
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "inbox", snoozed_until: null } })
      .then(fetchTasks)
      .catch((e) => { toast.error((e as Error).message); fetchTasks(); });
  }, [fetchTasks]);

  async function handleDueChange(taskId: string, date: string | null, time: string | null = null) {
    // A due date WITH a time is an EVENT (task_type=meeting): it resurfaces as a
    // reminder one working day before, instead of the regular two-day auto-snooze.
    // Clearing the time reverts an event back to a plain task.
    const isEvent = !!date && !!time;
    const wasMeeting = tasks.find((tk) => tk.id === taskId)?.task_type === "meeting";
    const nextType = isEvent ? "meeting" : wasMeeting ? "action" : undefined;
    const patch: Record<string, unknown> = { due_date: date, due_time: time };
    if (nextType) patch.task_type = nextType;
    // Persist the due date FIRST and wait for it: the snooze route below reads
    // due_date from the DB to clamp the wake moment to the deadline, so it must
    // see the value we just set (and we must not snooze if the date write failed).
    const ok = await patchTask(taskId, patch, (task) => ({ ...task, ...patch } as Task));
    // Setting a due date auto-snoozes the item until it needs attention (two
    // working days before for a task, one for an event), so it leaves the desk
    // now and resurfaces in time. Skipped when there isn't enough lead time
    // (moment → null).
    if (!ok || !date) return;
    const moment = isEvent ? eventReminderMoment(date, blocked) : autoSnoozeMoment(date, blocked);
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
        onToggleDone={handleToggleDone}
        onOpen={handleSelect}
        onSnooze={(id) => setSnoozeTaskId(id)}
        onSizeToggle={handleSizeToggle}
        onDueChange={task.plan_id ? undefined : handleDueChange}
        onPlanToggle={handlePlanToggle}
        plannedToday={task.planned_for === todayStr}
      />
    );
  }

  /** Persist a desk column's order: write today_position 0..n to `ids` in order,
   *  and (when a row is crossing in from another list) set its size. Optimistic
   *  + pending-reconciled so a racing refetch can't undo it. */
  async function applyDeskOrder(ids: string[], crossingId: string | null, crossingSize: "quick" | "medium" | "big" | null) {
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

  /** Drag reorders WITHIN a Today list only (quick / picked). Moving a task in
   *  or out of Today is done with the +/− button (planned_for), not drag; the
   *  pool has no manual order. */
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // The orderable Today lists depend on the mode: quick is always orderable;
    // ON adds the picked medium/big columns, OFF adds the surfaced regular desk.
    const orderable: Record<string, Task[]> = m131Enabled
      ? { [LIST_QUICK]: deskQuick, [LIST_MEDIUM]: deskMedium, [LIST_BIG]: deskBig }
      : { [LIST_QUICK]: deskQuick, [LIST_REGULAR]: deskRegular };
    const containerOf = (id: string | number): string | null => {
      const s = String(id);
      if (s.startsWith("list:")) return s;
      return Object.keys(orderable).find((k) => orderable[k].some((task) => task.id === s)) ?? null;
    };
    const from = containerOf(active.id);
    const to = containerOf(over.id);
    // Only reorder within the same orderable Today list.
    if (!from || from !== to || !orderable[from]) return;
    const column = orderable[from];
    const oldIndex = column.findIndex((row) => row.id === String(active.id));
    const newIndex = column.findIndex((row) => row.id === String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    await applyDeskOrder(arrayMove(column, oldIndex, newIndex).map((row) => row.id), null, null);
  }

  /** Snapshot today's committed plan to daily_plans (the build-day commit).
   *  Fire-and-forget: the picks themselves already persisted via planned_for. */
  const commitDayPlan = useCallback(() => {
    api("/api/tasks/day-plan", {
      method: "POST",
      body: {
        plan_date: todayStr,
        picked_task_ids: [...pickedIds],
        quick_total: deskQuick.length,
      },
    }).catch((e) => { if (e instanceof ApiError && e.status !== 401) toast.error(e.message); });
  }, [todayStr, pickedIds, deskQuick.length]);

  /** Add a task to / remove it from today's plan (planned_for). */
  function handlePlanToggle(taskId: string, addToToday: boolean) {
    const planned_for = addToToday ? todayStr : null;
    patchTask(taskId, { planned_for }, (task) => ({ ...task, planned_for }));
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
      {m131Enabled && (
        <button
          type="button"
          onClick={() => setBuildDayOpen(true)}
          aria-label={t("buildDay.open")}
          title={t("buildDay.open")}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sun className="h-4 w-4" />
        </button>
      )}
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
          {m131Enabled && (
            <BuildDayBanner
              locale={locale}
              mediumCandidates={[...deskMedium, ...rest.filter((task) => task.size !== "big")]}
              bigCandidates={[...deskBig, ...rest.filter((task) => task.size === "big")]}
              pickedIds={pickedIds}
              mediumQuota={mediumQuota}
              bigQuota={bigQuota}
              onPlanToggle={handlePlanToggle}
              onCommit={commitDayPlan}
              open={buildDayOpen}
              onOpenChange={setBuildDayOpen}
            />
          )}

          <ReviewBanner
            candidates={reviewCandidates}
            locale={locale}
            blocked={blocked}
            onChanged={fetchTasks}
            onSnooze={(id) => setSnoozeTaskId(id)}
          />

          {/* ── Plan-focus blocks — a separate section (⏱ NN ▶), independent of
              method131; one row per active focus commitment (§8.7). ── */}
          {planfocusEnabled && focusPlans.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{t("focus.heading")}</h2>
              <div className="space-y-1.5">
                {focusPlans.map((fp) => {
                  const planTitle = (locale === "he" ? fp.plan_title_he || fp.plan_title_en : fp.plan_title_en || fp.plan_title_he) ?? "";
                  const stageTitle = fp.current_stage
                    ? (locale === "he" && fp.current_stage.title_he ? fp.current_stage.title_he : fp.current_stage.title)
                    : null;
                  return (
                    <div key={fp.plan_id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                      <span className="flex items-center gap-1 text-sm font-medium tabular-nums text-muted-foreground" dir="ltr">
                        <Timer className="h-4 w-4" /> {t("focus.minutes", { n: fp.daily_minutes })}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" dir="auto">{planTitle}</p>
                        <p className="truncate text-xs text-muted-foreground" dir="auto">{stageTitle ?? t("focus.noStage")}</p>
                      </div>
                      {fp.completed_today ? (
                        <span className="whitespace-nowrap text-xs font-medium text-status-ok">{t("focus.doneToday")}</span>
                      ) : (
                        <Button size="sm" className="h-8 gap-1 text-xs" onClick={() => setFocusRun(fp)}>
                          <Play className="h-3 w-3" />
                          {t("focus.start")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
          {/* ── היום — quick always; then the day method's picked/regular lists ── */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{t("desk.today")}</h2>
              {/* Soft quota chips — method131 only (off mode has no quotas). */}
              {m131Enabled && (
                <>
                  <span className={cn("text-xs font-medium", pickedMedium > mediumQuota ? "text-status-late" : "text-muted-foreground")}>
                    {t("desk.mediumQuota", { n: pickedMedium, max: mediumQuota })}
                  </span>
                  <span className={cn("text-xs font-medium", pickedBig > bigQuota ? "text-status-late" : "text-muted-foreground")}>
                    {t("desk.bigQuota", { n: pickedBig, max: bigQuota })}
                  </span>
                </>
              )}
            </div>

            {/* Quick — do them all; marathon run available */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  <Zap className="h-3.5 w-3.5 text-status-warn" />
                  {t("desk.quick")}
                  <span className="rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskQuick.length}</span>
                </h3>
                {marathonEnabled && deskQuick.length > 0 && (
                  <Button size="sm" variant="outline" className="ms-auto h-7 gap-1 text-xs" onClick={() => setMarathonMode("quick")}>
                    <Play className="h-3 w-3" />
                    {t("desk.startRun")}
                  </Button>
                )}
              </div>
              {renderList(LIST_QUICK, deskQuick, "desk", t("desk.emptyQuick"))}
            </div>

            {m131Enabled ? (
              <>
                {/* Big — the one deliberate focus of the day */}
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {t("desk.big")}
                      <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskBig.length}</span>
                    </h3>
                  </div>
                  {renderList(LIST_BIG, deskBig, "desk", t("desk.emptyBig"))}
                </div>

                {/* Medium — the 3 picked for today; marathon runs over medium+big */}
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {t("desk.medium")}
                      <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskMedium.length}</span>
                    </h3>
                    {marathonEnabled && marathonRegularTasks.length > 0 && (
                      <Button size="sm" variant="outline" className="ms-auto h-7 gap-1 text-xs" onClick={() => setMarathonMode("regular")}>
                        <Play className="h-3 w-3" />
                        {t("desk.startRun")}
                      </Button>
                    )}
                  </div>
                  {renderList(LIST_MEDIUM, deskMedium, "desk", t("desk.emptyMedium"))}
                </div>
              </>
            ) : (
              /* Off mode — a single deadline-driven regular desk (spec §1) */
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("desk.regular")}
                    <span className="ms-1 rounded-full bg-secondary px-1.5 text-[11px] font-medium">{deskRegular.length}</span>
                  </h3>
                  {marathonEnabled && deskRegular.length > 0 && (
                    <Button size="sm" variant="outline" className="ms-auto h-7 gap-1 text-xs" onClick={() => setMarathonMode("regular")}>
                      <Play className="h-3 w-3" />
                      {t("desk.startRun")}
                    </Button>
                  )}
                </div>
                {renderList(LIST_REGULAR, deskRegular, "desk", t("desk.emptyRegular"))}
              </div>
            )}
          </section>
          </DndContext>

          {/* ── The catch-all (collapsed) — the rest (ON) / waiting (OFF) ── */}
          {(() => {
            const catchAll = m131Enabled ? rest : waiting;
            const heading = m131Enabled ? t("desk.rest") : t("desk.waiting");
            const empty = m131Enabled ? t("desk.emptyRest") : t("desk.emptyPool");
            return (
              <section>
                <button
                  className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground"
                  onClick={() => setShowPool((v) => !v)}
                >
                  {showPool ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {heading}
                  <span className="rounded-full bg-secondary px-1.5 text-[11px] font-medium">{catchAll.length}</span>
                </button>
                {showPool && (
                  catchAll.length === 0 ? (
                    <p className="py-2 text-center text-sm text-muted-foreground">{empty}</p>
                  ) : (
                    // Flat, already sorted (rest: deadline→fell→tenure→priority;
                    // waiting: by date). No size grouping — spec §3.3 "מוצגת שטוחה".
                    <div className="space-y-1.5">
                      {catchAll.map((task) => renderRow(task, "waiting"))}
                    </div>
                  )
                )}
              </section>
            );
          })()}

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
          tasks={marathonMode === "quick" ? deskQuick : marathonRegularTasks}
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
              body: { size: marathonMode === "quick" ? "medium" : "quick" },
            });
            fetchTasks();
          }}
          onExit={() => { setMarathonMode(null); fetchTasks(); }}
        />
      )}

      {focusRun && (
        <FocusSession
          key={focusRun.plan_id}
          planId={focusRun.plan_id}
          planTitle={(locale === "he" ? focusRun.plan_title_he || focusRun.plan_title_en : focusRun.plan_title_en || focusRun.plan_title_he) ?? ""}
          dailyMinutes={focusRun.daily_minutes}
          locale={locale}
          onExit={() => { setFocusRun(null); fetchTasks(); fetchFocusToday(); }}
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

      <DecisionDialog
        open={!!decisionTask}
        taskTitle={decisionTask ? (locale === "he" && decisionTask.title_he ? decisionTask.title_he : decisionTask.title) : ""}
        onClose={() => setDecisionTask(null)}
        onConfirm={(decision) => {
          const tk = decisionTask;
          setDecisionTask(null);
          if (tk) void runToggleDone(tk, true, decision);
        }}
      />

      <SnoozeDialog
        open={!!snoozeTaskId}
        onClose={() => setSnoozeTaskId(null)}
        onConfirm={handleSnoozeConfirm}
        dueDate={snoozeTaskId ? tasks.find((task) => task.id === snoozeTaskId)?.due_date ?? null : null}
        onUpdateDeadline={
          snoozeTaskId
            ? async (newDue) => {
                const id = snoozeTaskId;
                await patchTask(id, { due_date: newDue }, (task) => ({ ...task, due_date: newDue }));
                toast.success(t("actions.snooze"));
                fetchTasks();
              }
            : undefined
        }
      />
    </>
  );
}
