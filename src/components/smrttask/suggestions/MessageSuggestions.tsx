"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Bell, Clock, Zap, Circle, Layers, Home, MapPin, ThumbsDown, ListPlus, Check, RotateCcw, CalendarPlus, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { LinkActions } from "@/components/smrttask/common/LinkActions";
import { taskActionNuggets } from "@/lib/smrttask/links";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { DueDateChip } from "@/components/smrttask/tasks/DueDateChip";
import { ContextButton } from "@/components/smrttask/tasks/ContextPanel";
import { AssigneeButton } from "@/components/smrttask/tasks/AssigneeButton";
import { TaskDetail } from "@/components/smrttask/tasks/TaskDetail";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { AddEventModal } from "@/components/smrttask/tasks/AddEventModal";
import { DismissDialog } from "./DismissDialog";
import { PlanProposals } from "./PlanProposals";
import { MergeModal, type MergeMinimizeJob } from "@/components/smrttask/merge/MergeModal";
import { useMergeJob, useMergeCompletedListener } from "@/contexts/MergeJobContext";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { effectiveDeadline, autoSnoozeMoment, eventReminderMoment, todayISO } from "@/lib/workdays";
import { undoToast } from "@/components/ui/undo-toast";
import { dueLabel } from "@/components/smrttask/tasks/DueDateChip";
import { cn } from "@/lib/utils";
import type { Task, TaskNeed } from "@/types/task";

/**
 * The suggestions inbox — the decision queue. Cards are deliberately minimal:
 * title + ✨ (everything identity-related lives in the context panel), the
 * AI-proposed ⚡size (tap to flip BEFORE approving), and the colored deadline
 * chip. Plan assignment proposals surface above the AI suggestions.
 */
export function MessageSuggestions({ locale, onUpdate }: { locale: string; onUpdate?: () => void }) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const tMerge = useTranslations("merge");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const blocked = useWorkCalendar();

  const [suggestions, setSuggestions] = useState<Task[]>([]);
  // Suggestions that resolved themselves before you approved them: a WhatsApp
  // matter that opened as a suggestion and then closed when you replied (T740).
  // They go to status=pending_completion + unverified, which neither the
  // suggestions list (inbox+unverified) nor the task list (verified) shows —
  // so without this they vanished silently. Surfaced as a "resolved itself"
  // strip you can confirm (→done) or reopen (→back to a suggestion).
  const [resolved, setResolved] = useState<Task[]>([]);
  // Plan tasks whose deadline is near — surfaced in the inbox to pick for today.
  // Plan tasks flow through the inbox (never auto-onto the desk); this is where
  // you commit one to "היום".
  const [planTasks, setPlanTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string; sourceType: string | null } | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);
  const [addEventTaskId, setAddEventTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const mergeJob = useMergeJob();

  // When a background merge completes elsewhere (e.g. user reopened from
  // the global chip on /tasks), refresh our suggestion list so the
  // archived sources disappear.
  useMergeCompletedListener(useCallback(() => {
    fetchSuggestions();
    onUpdate?.();
  // fetchSuggestions/onUpdate change identity per render — we want the
  // listener installed once, not re-installed on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  const handleMinimize = useCallback((job: MergeMinimizeJob) => {
    toast.info(tMerge("bgRunningToast"));
    mergeJob.startJob(job.promise, {
      sources: job.sources,
      targetMode: job.targetMode,
      existingTargetId: job.existingTargetId,
      startedAtPath: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeJob.startJob]);

  // ?focus=<id> from a /whatsapp deep-link → scroll the matching
  // suggestion card into view and briefly highlight it.
  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const focusNodeRef = useRef<HTMLDivElement | null>(null);
  // Subsequent refetches must NOT flip the global `loading` flag — that
  // unmounts the open <TaskDetail> sheet mid-edit.
  const initialLoadDoneRef = useRef(false);

  const fetchSuggestions = useCallback(async () => {
    if (!initialLoadDoneRef.current) setLoading(true);
    try {
      // mine=true → personal scope; the API also hides draft-plan tasks.
      // Pull inbox suggestions AND pending_completion (suggestions that closed
      // themselves before approval), then split by status below.
      const [{ tasks }, sessionRes] = await Promise.all([
        api<{ tasks: Task[] }>(
          "/api/tasks?status=inbox,pending_completion&verified=false&has_source=true&mine=true&limit=1000",
        ),
        // Claude-Code session proposals ("הצעות") have no source message, so the
        // has_source filter above skips them — pull them in by tag and merge.
        api<{ tasks: Task[] }>(
          "/api/tasks?status=inbox,pending_completion&verified=false&mine=true&tag=via-claude-session&limit=1000",
        ).catch(() => ({ tasks: [] as Task[] })),
      ]);
      // Merge + dedupe by id (the two result sets are disjoint, but guard anyway).
      const byId = new Map<string, Task>();
      for (const t of [...(tasks ?? []), ...(sessionRes.tasks ?? [])]) byId.set(t.id, t);
      const all = [...byId.values()];
      // Newest-resolved first — these are "did you notice this closed?" cards.
      setResolved(
        all.filter((t) => t.status === "pending_completion")
          .sort((a, b) => (b.status_changed_at ?? b.created_at ?? "").localeCompare(a.status_changed_at ?? a.created_at ?? "")),
      );
      // Undated verified tasks — verified, active, non-quick tasks with no date and
      // not already committed to today. These are what used to fill the separate
      // "לתכנן להיום" section; they now merge into the normal inbox list (one list,
      // no separate box) so they stay visible for a decision. A "×N" badge on each
      // shows how many times the nightly rollover has un-planned it (return_count).
      let undatedTasks: Task[] = [];
      try {
        const { tasks: verified } = await api<{ tasks: Task[] }>(
          "/api/tasks?status=inbox,in_progress&verified=true&mine=true&limit=1000",
        );
        const today = todayISO();
        undatedTasks = (verified ?? []).filter(
          (t) => t.size !== "quick" && !t.due_date && t.planned_for !== today,
        );
      } catch { /* endpoint unavailable → no undated tasks this pass */ }
      // Inbox = unverified suggestions + undated verified tasks, one list.
      // Urgency order: earliest effective deadline first, undated last; within the
      // undated group the most-returned float up, then newest-first.
      const inboxById = new Map<string, Task>();
      for (const t of [...all.filter((t) => t.status === "inbox"), ...undatedTasks]) inboxById.set(t.id, t);
      const sorted = [...inboxById.values()].sort((a, b) => {
        const da = effectiveDeadline(a);
        const db = effectiveDeadline(b);
        if (da && db && da !== db) return da.localeCompare(db);
        if (da && !db) return -1;
        if (!da && db) return 1;
        const ra = a.return_count ?? 0;
        const rb = b.return_count ?? 0;
        if (ra !== rb) return rb - ra;
        return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      });
      setSuggestions(sorted);
      // MY plan tasks with a near deadline (due within ~4 days or overdue), not
      // blocked, not already picked — surfaced here to pick for today. Plan tasks
      // never auto-fill the desk; the inbox is where you commit one. smrtPlan
      // off → empty (endpoint 404/deny caught).
      try {
        const { tasks: pt } = await api<{ tasks: (Task & { needs?: TaskNeed[] })[] }>("/api/plan/my-tasks");
        const today = todayISO();
        const soonDate = new Date();
        soonDate.setDate(soonDate.getDate() + 4);
        // Local date (matches todayISO / effectiveDeadline) — avoid UTC slice,
        // which would shift the window by a day in early-morning local hours.
        const soonISO = `${soonDate.getFullYear()}-${String(soonDate.getMonth() + 1).padStart(2, "0")}-${String(soonDate.getDate()).padStart(2, "0")}`;
        setPlanTasks(
          (pt ?? [])
            .filter((t) => {
              if (t.planned_for === today) return false;
              if (!["inbox", "in_progress", "pending_completion"].includes(t.status ?? "")) return false;
              if ((t.needs ?? []).some((n) => !n.satisfied)) return false; // blocked → not actionable
              const dl = effectiveDeadline(t);
              return !!dl && dl <= soonISO;
            })
            .sort((a, b) => (effectiveDeadline(a) ?? "").localeCompare(effectiveDeadline(b) ?? "")),
        );
      } catch { /* smrtPlan not enabled → no plan section */ }
      setSelected(new Set());
      // Re-bind editTask to the freshly fetched row so an open TaskDetail
      // sheet renders the saved values instead of the pre-save snapshot.
      setEditTask((prev) => (prev ? sorted.find((s) => s.id === prev.id) ?? null : null));
    } catch {
      // 401 etc — list stays as-is
    } finally {
      initialLoadDoneRef.current = true;
      setLoading(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("smrtesy:badge-refresh"));
      }
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  // Scroll-to-focus when opened via a deep link like /he/inbox?focus=<task_id>.
  useEffect(() => {
    if (!focusId || loading) return;
    if (focusedRef.current === focusId) return;
    const exists = suggestions.some((s) => s.id === focusId);
    if (!exists) return;
    focusedRef.current = focusId;
    requestAnimationFrame(() => {
      focusNodeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const params = new URLSearchParams(searchParams.toString());
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [focusId, loading, suggestions, pathname, router, searchParams]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(suggestions.map((s) => s.id)));
  }

  function clearSelection() { setSelected(new Set()); }

  // Optimistically drop card(s) from EVERY local list so an action feels
  // instant, no matter which section the item is showing in — the AI-suggestion
  // list (which now also carries returned tasks) or the self-resolved strip.
  // (Approve / dismiss from inside the detail window go through here too.)
  // The API call + background refetch reconcile; on failure we refetch to restore.
  function removeLocal(ids: string[]) {
    const set = new Set(ids);
    setSuggestions((prev) => prev.filter((s) => !set.has(s.id)));
    setResolved((prev) => prev.filter((s) => !set.has(s.id)));
    setPlanTasks((prev) => prev.filter((s) => !set.has(s.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }

  // A self-resolved suggestion: confirm it's done (→ archived) or reopen it
  // back into the suggestion inbox if it wasn't actually finished.
  function handleConfirmResolved(taskId: string) {
    setResolved((prev) => prev.filter((s) => s.id !== taskId));
    toast.success(tTasks("actions.complete"));
    api(`/api/tasks/${taskId}/complete`, { method: "POST" })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  function handleReopenResolved(taskId: string) {
    setResolved((prev) => prev.filter((s) => s.id !== taskId));
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "inbox" } })
      .then(() => { fetchSuggestions(); onUpdate?.(); })
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  function handleApprove(taskId: string) {
    // An event's whole purpose is the reminder, so "approve" CLOSES it via the
    // canonical complete flow (status=archived + completed_at, recurrence spawn)
    // rather than promoting it to a verified task.
    const task = suggestions.find((s) => s.id === taskId);
    const isEvent = task?.task_type === "meeting";
    // An already-verified undated task is committed to today, not "approved"
    // again — otherwise the manually_verified no-op leaves planned_for null and
    // the card just comes back. Covers the TaskDetail approve path (the card CTA
    // already calls handlePlanToday directly).
    if (!isEvent && task?.manually_verified === true) {
      handlePlanToday(taskId);
      return;
    }
    removeLocal([taskId]);
    // Daily method: quick → today, dated → its date, undated regular/big → pool.
    // Say WHERE it landed so an approved task never feels lost in the collapsed pool.
    const today = todayISO();
    const dest = isEvent
      ? t("reminderClosed")
      : task?.size === "quick" || (task?.due_date && task.due_date <= today) || task?.planned_for === today
        ? t("approvedToToday")
        : task?.due_date
          ? t("approvedScheduled")
          : t("approvedToPool");
    toast.success(dest);
    const request = isEvent
      ? api(`/api/tasks/${taskId}/complete`, { method: "POST" })
      : api(`/api/tasks/${taskId}`, { method: "PATCH", body: { manually_verified: true } });
    request
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  async function handleSizeSet(taskId: string, size: "quick" | "medium" | "big") {
    setSuggestions((prev) => prev.map((s) => (s.id === taskId ? { ...s, size } : s)));
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { size } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  function unsnooze(taskId: string) {
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "inbox", snoozed_until: null } })
      .then(() => { fetchSuggestions(); onUpdate?.(); })
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  async function handleDueChange(taskId: string, date: string | null, time: string | null = null) {
    // A due date WITH a time is an EVENT (task_type=meeting): it resurfaces as a
    // reminder one working day before, instead of the regular two-day auto-snooze.
    // Clearing the time reverts an event back to a plain task, so a de-timed
    // reminder stops reading as "תזכורת" and its approve stops closing it.
    const isEvent = !!date && !!time;
    const wasMeeting = suggestions.find((s) => s.id === taskId)?.task_type === "meeting";
    const nextType = isEvent ? "meeting" : wasMeeting ? "action" : undefined;
    const patch: Record<string, unknown> = { due_date: date, due_time: time };
    if (nextType) patch.task_type = nextType;
    setSuggestions((prev) => prev.map((s) => (s.id === taskId ? { ...s, ...patch } as Task : s)));
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: patch });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
      return;
    }
    // Setting a due date auto-snoozes the suggestion until it needs attention
    // (two working days before for a task, one for an event) — it leaves the
    // inbox now and resurfaces in time. Skipped when there isn't enough lead
    // time (moment → null).
    if (!date) return;
    const moment = isEvent ? eventReminderMoment(date, blocked) : autoSnoozeMoment(date, blocked);
    if (!moment) return;
    removeLocal([taskId]);
    api(`/api/tasks/${taskId}/snooze`, { method: "POST", body: { until: moment.iso } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
    undoToast({
      message: tTasks("undo.autoSnoozed", { date: dueLabel(moment.dateISO) }),
      undoLabel: tTasks("row.undo"),
      onUndo: () => unsnooze(taskId),
      changeLabel: tTasks("undo.changeDate"),
      onChange: () => setSnoozeTaskId(taskId),
    });
  }

  async function handleContextToggle(task: Task, ctx: "home" | "outside") {
    const context = task.context === ctx ? null : ctx;
    setSuggestions((prev) => prev.map((s) => (s.id === task.id ? { ...s, context } : s)));
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { context } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  async function handleAssign(taskId: string, userId: string | null) {
    setSuggestions((prev) => prev.map((s) => (s.id === taskId ? { ...s, assigned_to_user_id: userId } : s)));
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { assigned_to_user_id: userId } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  function handleFastDismiss(taskId: string) {
    removeLocal([taskId]);
    toast.success(t("fastDismissed"));
    api(`/api/tasks/${taskId}/dismiss-fast`, { method: "POST" })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  function handleSnoozeConfirm(untilIso: string) {
    if (!snoozeTaskId) return;
    const id = snoozeTaskId;
    removeLocal([id]);
    toast.success(tTasks("actions.snooze"));
    api(`/api/tasks/${id}/snooze`, { method: "POST", body: { until: untilIso } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  function handleBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    removeLocal(ids);
    toast.success(t("approve"));
    api(`/api/tasks/bulk-approve`, { method: "POST", body: { task_ids: ids } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  async function handleBulkDismissFast() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    removeLocal(ids);
    toast.success(t("fastDismissed"));
    api(`/api/tasks/bulk-dismiss-fast`, { method: "POST", body: { task_ids: ids } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  function openDismissDialog(taskId: string, title: string, sourceType: string | null) {
    setDismissTarget({ id: taskId, title, sourceType });
  }

  // Returned-task triage: commit it to today (planned_for = today). Clears the
  // "×N returned" nag by putting it on today's desk; leaves the inbox list.
  function handlePlanToday(taskId: string) {
    removeLocal([taskId]);
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { planned_for: todayISO() } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  // Plan-task triage: pull a plan task onto today's desk (planned_for = today).
  // It keeps living on the plan board; this is the daily-method "pick for today".
  function handlePlanPickToday(taskId: string) {
    setPlanTasks((prev) => prev.filter((task) => task.id !== taskId));
    api(`/api/tasks/${taskId}`, { method: "PATCH", body: { planned_for: todayISO() } })
      .then(() => onUpdate?.())
      .catch((e) => { toast.error((e as Error).message); fetchSuggestions(); });
  }

  const body = loading ? (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
    </div>
  ) : (
    <div className="space-y-4">
      {/* Plan assignments awaiting my accept/decline */}
      <PlanProposals locale={locale} onChanged={() => { onUpdate?.(); }} />

      {/* Suggestions that closed themselves before you approved them (T740):
          surfaced here so they don't vanish silently. Confirm → archived;
          reopen → back into the suggestion inbox. */}
      {resolved.length > 0 && (
        <div className="rounded-lg border border-status-ok/30 bg-status-ok-bg/40 p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-status-ok">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span dir="auto">{t("resolvedTitle", { count: resolved.length })}</span>
          </p>
          <p className="text-[11px] text-muted-foreground" dir="auto">{t("resolvedHint")}</p>
          {resolved.map((task) => {
            const rTitle = locale === "he" && task.title_he ? task.title_he : task.title;
            return (
              <div key={task.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm line-through opacity-70" dir="auto">{rTitle}</span>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-status-ok" onClick={() => handleConfirmResolved(task.id)}>
                  <Check className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("confirmDone")}</span>
                </Button>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-muted-foreground" onClick={() => handleReopenResolved(task.id)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("reopen")}</span>
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {/* Plan tasks with a near deadline — pick one for today. Plan tasks flow
          through the inbox and live on their own board; the desk never
          auto-fills them, so this is where you commit one to "היום". */}
      {planTasks.length > 0 && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <ClipboardList className="h-3.5 w-3.5 shrink-0" />
            <span dir="auto">{t("planTodayTitle", { count: planTasks.length })}</span>
          </p>
          <p className="text-[11px] text-muted-foreground" dir="auto">{t("planTodayHint")}</p>
          {planTasks.map((task) => {
            const pTitle = locale === "he" && task.title_he ? task.title_he : task.title;
            const dl = effectiveDeadline(task);
            return (
              <div key={task.id} className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                <button type="button" className="min-w-0 flex-1 truncate text-start text-sm" dir="auto" onClick={() => setEditTask(task)}>{pTitle}</button>
                {dl && (
                  <span className="shrink-0 text-[10px] text-muted-foreground" dir="ltr">
                    {new Date(`${dl}T00:00:00`).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", { day: "numeric", month: "short" })}
                  </span>
                )}
                <IconButton label={tTasks("row.addToToday")} color="primary" className="h-7 w-7" onClick={() => handlePlanPickToday(task.id)}>
                  <ListPlus />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}

      {suggestions.length === 0 && resolved.length === 0 && planTasks.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Bell className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>{t("noSuggestions")}</p>
        </div>
      ) : suggestions.length === 0 ? null : (
        <div className="space-y-3">
          <SuggestionToolbar
            total={suggestions.length}
            filtered={suggestions.length}
            selectedCount={selected.size}
            searchQuery=""
            onSearchChange={() => {}}
            onSelectAll={selectAllFiltered}
            onClearSelection={clearSelection}
            onBulkApprove={handleBulkApprove}
            onBulkDismissFast={handleBulkDismissFast}
            onBulkMerge={selected.size >= 1 ? () => setMergeOpen(true) : undefined}
            hideSearch
          />

          {suggestions.map((task) => {
            const source = task.source_messages ?? null;
            const title = locale === "he" && task.title_he ? task.title_he : task.title;
            // An event surfaces as a reminder — frame the shown title as such
            // (the stored title stays clean for the agenda / info-board).
            const displayTitle = task.task_type === "meeting" ? t("reminderPrefix", { title }) : title;
            const isSelected = selected.has(task.id);
            const isFocused = task.id === focusId;
            // Action nuggets — clean one-click buttons (e.g. "פתח את הצ'אט
            // ב-Claude Code"). These replace the raw session link.
            const nuggets = taskActionNuggets(task);
            // Machine/system tags are plumbing, not user-facing labels: the
            // `via-claude-session` marker and the `claude-session:<id>` pointer
            // (whose id the nugget already links to) would otherwise render as
            // an ugly "half the session address" chip. Hide them from display.
            const visibleTags = (task.tags ?? []).filter(
              (tag) => tag.toLowerCase() !== "via-claude-session" && !/^claude-session:/i.test(tag),
            );
            // An already-verified undated task resurfaced in the inbox (the old
            // "לתכנן להיום" set). Its primary CTA is "commit to today", not another
            // "approve" no-op. The "↻N" badge shows how many times the nightly
            // rollover has un-planned it (return_count) — hidden at 0.
            const returnCount = task.return_count ?? 0;
            const isBacklog = task.manually_verified === true;

            return (
              <Card
                key={task.id}
                ref={isFocused ? focusNodeRef : undefined}
                className={cn(
                  isFocused
                    ? "ring-2 ring-status-warn animate-pulse"
                    : isSelected
                    ? "ring-2 ring-primary/50"
                    : undefined,
                )}
              >
                <CardContent className="p-4">
                  {/* Top row: select · title (click → edit) · source + date
                      cluster pinned to the trailing (left in RTL) edge. */}
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(task.id)}
                      className="mt-1 shrink-0 h-4 w-4 cursor-pointer"
                      aria-label={t("selectAll")}
                    />
                    <h4
                      className="flex-1 min-w-0 text-sm font-medium cursor-pointer"
                      dir="auto"
                      onClick={() => setEditTask(task)}
                    >
                      {displayTitle}
                    </h4>
                    <div dir="ltr" className="flex shrink-0 items-center gap-1">
                      {returnCount >= 1 && (
                        <span
                          title={t("returnedBadgeTooltip", { count: returnCount })}
                          className="inline-flex items-center gap-0.5 rounded-full border border-status-warn/40 bg-status-warn-bg/50 px-1.5 py-0.5 text-[10px] font-medium text-status-warn"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {returnCount}
                        </span>
                      )}
                      {source && <SourceLink source={source} stopPropagation />}
                      <DueDateChip
                        deadline={effectiveDeadline(task)}
                        time={task.due_date ? task.due_time : null}
                        locale={locale}
                        blocked={blocked}
                        onChange={(d, tm) => handleDueChange(task.id, d, tm)}
                      />
                    </div>
                  </div>

                  {task.description ? (
                    <p
                      className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words cursor-pointer"
                      dir="auto"
                      onClick={() => setEditTask(task)}
                    >
                      {task.description}
                    </p>
                  ) : null}

                  {/* Action nuggets — one-click deep links, immediately below
                      the description (no heading). */}
                  {nuggets.length > 0 && <LinkActions links={nuggets} />}

                  {(task.related_contact || visibleTags.length > 0) && (
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {task.related_contact && (
                        <Badge variant="outline" className="text-[10px]">
                          {task.related_contact}
                        </Badge>
                      )}
                      {visibleTags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] capitalize">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <SuggestionActions
                    task={task}
                    locale={locale}
                    infoProjectId={task.project_id}
                    infoTitle={title}
                    infoBody={task.description}
                    isBacklog={isBacklog}
                    onSizeChange={(size) => handleSizeSet(task.id, size)}
                    onContextToggle={(ctx) => handleContextToggle(task, ctx)}
                    onAssign={(uid) => handleAssign(task.id, uid)}
                    onFastDismiss={() => handleFastDismiss(task.id)}
                    onDismissWithReason={() => openDismissDialog(task.id, title, source?.source_type ?? null)}
                    onApprove={() => handleApprove(task.id)}
                    onPlanToday={() => handlePlanToday(task.id)}
                    onSnooze={() => setSnoozeTaskId(task.id)}
                    onAddEvent={() => setAddEventTaskId(task.id)}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      <CombinedSearch locale={locale} onUpdate={() => { fetchSuggestions(); onUpdate?.(); }}>
        {body}
      </CombinedSearch>

      <DismissDialog
        taskId={dismissTarget?.id ?? null}
        taskTitle={dismissTarget?.title}
        sourceType={dismissTarget?.sourceType ?? null}
        open={!!dismissTarget}
        onClose={() => setDismissTarget(null)}
        onDismissed={() => {
          // Drop the card instantly; refetch in the background to also catch
          // any cascaded dismissals of sibling suggestions.
          if (dismissTarget) removeLocal([dismissTarget.id]);
          fetchSuggestions();
          onUpdate?.();
        }}
      />

      <TaskDetail
        task={editTask}
        locale={locale}
        open={!!editTask}
        onClose={() => setEditTask(null)}
        onUpdate={fetchSuggestions}
        initialEditingFields
        onFastDismiss={handleFastDismiss}
        onDismissWithReason={(taskId) => {
          const s = suggestions.find((row) => row.id === taskId);
          const sTitle = s ? (locale === "he" && s.title_he ? s.title_he : s.title) : "";
          openDismissDialog(taskId, sTitle, s?.source_messages?.source_type ?? null);
        }}
        onApprove={handleApprove}
      />

      <SnoozeDialog
        open={!!snoozeTaskId}
        onClose={() => setSnoozeTaskId(null)}
        onConfirm={handleSnoozeConfirm}
      />

      {addEventTaskId && (
        <AddEventModal
          taskId={addEventTaskId}
          open={!!addEventTaskId}
          onClose={() => setAddEventTaskId(null)}
          onDone={() => { removeLocal([addEventTaskId]); fetchSuggestions(); onUpdate?.(); }}
          locale={locale}
        />
      )}

      <MergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        sources={suggestions
          .filter((s) => selected.has(s.id))
          .map((s) => ({
            id: s.id,
            title: s.title,
            title_he: s.title_he,
            task_type: s.task_type,
            status: s.status,
            ai_confidence: s.ai_confidence,
          }))}
        locale={locale}
        onMinimize={handleMinimize}
        onMerged={(result) => {
          const itemCount = (result.task?.checklist as unknown[] | undefined)?.length ?? 0;
          toast.success(itemCount > 0
            ? tMerge("successToastWithChecklist", { count: itemCount })
            : tMerge("successToast"));
          setSelected(new Set());
          fetchSuggestions();
          onUpdate?.();
        }}
      />
    </>
  );
}

/**
 * Per-card action row — one unified icon-button style throughout. In RTL,
 * start (right) to end (left):
 *   meta:   ✨ AI · ⚡ size (filled=quick) · 🏠 home (filled=home) · ⏰ snooze · 📄 save-info
 *   [flex]
 *   decide: ✗ dismiss · 👎 dismiss+learn · ＋ convert-to-task · ✓ done
 *
 * No edit button — clicking the card body opens the edit window. "convert to
 * task" moves the suggestion into the task lists; "done" closes it in one step.
 */
function SuggestionActions({
  task,
  locale,
  infoProjectId,
  infoTitle,
  infoBody,
  isBacklog,
  onSizeChange,
  onContextToggle,
  onAssign,
  onFastDismiss,
  onDismissWithReason,
  onApprove,
  onPlanToday,
  onSnooze,
  onAddEvent,
}: {
  task: Task;
  locale: string;
  infoProjectId: string | null;
  infoTitle: string;
  infoBody: string | null;
  isBacklog: boolean;
  onSizeChange: (size: "quick" | "medium" | "big") => void;
  onContextToggle: (ctx: "home" | "outside") => void;
  onAssign: (userId: string | null) => void;
  onFastDismiss: () => void;
  onDismissWithReason: () => void;
  onApprove: () => void;
  onPlanToday: () => void;
  onSnooze: () => void;
  onAddEvent: () => void;
}) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const tEvents = useTranslations("events");
  const isQuick = task.size === "quick";
  const isHome = task.context === "home";
  // An event reminder: "approve" reads as "close the reminder" (a ✓), not "add".
  const isEvent = task.task_type === "meeting";
  const isOutside = task.context === "outside";

  return (
    <div className="flex gap-0.5 mt-3 items-center flex-wrap [&>button]:h-8 [&>button]:w-8">
      {/* ── meta ───────────────────────────────────────────────────────── */}
      <ContextButton task={task} locale={locale} className="h-9 w-9 md:h-8 md:w-8 [&_svg]:size-4" />
      {/* Effort level — "file by level" triage. Three levels (quick/regular/big);
          the trigger icon reflects the current one. Events have no level. */}
      {!isEvent && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={tTasks("sizeChange")}
              aria-label={tTasks("sizeChange")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isQuick ? <Zap className="h-4 w-4 fill-current text-status-warn" /> : task.size === "big" ? <Layers className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="min-w-[7rem]">
            <DropdownMenuRadioGroup value={task.size ?? "medium"} onValueChange={(v) => onSizeChange(v as "quick" | "medium" | "big")}>
              <DropdownMenuRadioItem value="big">{tTasks("sizeBig")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="medium">{tTasks("sizeMedium")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="quick">{tTasks("sizeQuick")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <IconButton
        label={tTasks("contextFilter.home")}
        color="primary"
        className={isHome ? "text-primary" : undefined}
        aria-pressed={isHome}
        onClick={() => onContextToggle("home")}
      >
        <Home className={isHome ? "fill-current" : undefined} />
      </IconButton>
      <IconButton
        label={tTasks("contextFilter.outside")}
        color="primary"
        className={isOutside ? "text-primary" : undefined}
        aria-pressed={isOutside}
        onClick={() => onContextToggle("outside")}
      >
        <MapPin className={isOutside ? "fill-current" : undefined} />
      </IconButton>
      <IconButton label={tTasks("actions.snooze")} color="amber" onClick={onSnooze}>
        <Clock />
      </IconButton>
      <IconButton label={tEvents("addEvent")} color="primary" onClick={onAddEvent}>
        <CalendarPlus />
      </IconButton>
      <SaveAsInfoButton
        defaultProjectId={infoProjectId}
        defaultTitle={infoTitle}
        defaultBody={infoBody}
      />
      {/* Assign to a teammate — manager-only (renders nothing otherwise). */}
      <AssigneeButton assignedTo={task.assigned_to_user_id} onAssign={onAssign} />

      <div className="flex-1" />

      {/* ── decide ─────────────────────────────────────────────────────── */}
      <IconButton label={t("fastDismiss")} color="red" onClick={onFastDismiss}>
        <X />
      </IconButton>
      <IconButton label={t("dismissWithReason")} color="violet" onClick={onDismissWithReason}>
        <ThumbsDown />
      </IconButton>
      {/* NO "complete" button on suggestions. A suggestion was never approved,
          so "בוצע" makes no sense here — and the green ✓ sat next to "אשר"
          and read as approve, silently archiving suggestions one tap at a
          time (the June-2026 "suggestions vanished" incident). Completing
          belongs to the task list, after approval.
          An already-verified undated task (the backlog resurfaced in the inbox)
          is committed to today via its CTA, not "approved" again — an approve
          no-op would leave planned_for null and the card just comes back. */}
      <IconButton
        label={isEvent ? t("closeReminder") : isBacklog ? tTasks("row.addToToday") : t("approve")}
        color="blue"
        onClick={isEvent ? onApprove : isBacklog ? onPlanToday : onApprove}
      >
        {isEvent ? <Check /> : <ListPlus />}
      </IconButton>
    </div>
  );
}
