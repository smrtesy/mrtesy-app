"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, X, Bell, Clock, Zap, Home } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { DueDateChip } from "@/components/smrttask/tasks/DueDateChip";
import { TaskDetail } from "@/components/smrttask/tasks/TaskDetail";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { DismissDialog } from "./DismissDialog";
import { PlanProposals } from "./PlanProposals";
import { MergeModal, type MergeMinimizeJob } from "@/components/smrttask/merge/MergeModal";
import { useMergeJob, useMergeCompletedListener } from "@/contexts/MergeJobContext";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { effectiveDeadline } from "@/lib/workdays";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

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
  const [loading, setLoading] = useState(true);
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string; sourceType: string | null } | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);
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
      const { tasks } = await api<{ tasks: Task[] }>(
        "/api/tasks?status=inbox&verified=false&has_source=true&mine=true&limit=1000",
      );
      // Urgency order: earliest effective deadline first, undated last,
      // newest-first within each group.
      const sorted = [...(tasks ?? [])].sort((a, b) => {
        const da = effectiveDeadline(a);
        const db = effectiveDeadline(b);
        if (da && db && da !== db) return da.localeCompare(db);
        if (da && !db) return -1;
        if (!da && db) return 1;
        return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      });
      setSuggestions(sorted);
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

  async function handleApprove(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { manually_verified: true } });
      toast.success(t("approve"));
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSizeToggle(task: Task) {
    const size = task.size === "quick" ? "regular" : "quick";
    setSuggestions((prev) => prev.map((s) => (s.id === task.id ? { ...s, size } : s)));
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { size } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  async function handleDueChange(taskId: string, date: string | null) {
    setSuggestions((prev) => prev.map((s) => (s.id === taskId ? { ...s, due_date: date } : s)));
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { due_date: date } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  async function handleHomeToggle(task: Task) {
    const context = task.context === "home" ? null : "home";
    setSuggestions((prev) => prev.map((s) => (s.id === task.id ? { ...s, context } : s)));
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { context } });
    } catch (e) {
      toast.error((e as Error).message);
      fetchSuggestions();
    }
  }

  async function handleFastDismiss(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/dismiss-fast`, { method: "POST" });
      toast.success(t("fastDismissed"));
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleComplete(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/complete`, { method: "POST" });
      // Undo restores status=inbox; manually_verified is untouched, so the
      // row comes straight back as a suggestion.
      toast.success(tTasks("actions.complete"), {
        action: {
          label: tTasks("row.undo"),
          onClick: () => {
            api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "inbox" } })
              .then(() => { fetchSuggestions(); onUpdate?.(); })
              .catch((e) => toast.error((e as Error).message));
          },
        },
      });
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSnoozeConfirm(untilIso: string) {
    if (!snoozeTaskId) return;
    try {
      await api(`/api/tasks/${snoozeTaskId}/snooze`, {
        method: "POST",
        body: { until: untilIso },
      });
      toast.success(tTasks("actions.snooze"));
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api(`/api/tasks/bulk-approve`, { method: "POST", body: { task_ids: ids } });
      toast.success(t("approve"));
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleBulkDismissFast() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api(`/api/tasks/bulk-dismiss-fast`, { method: "POST", body: { task_ids: ids } });
      toast.success(t("fastDismissed"));
      fetchSuggestions();
      onUpdate?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function openDismissDialog(taskId: string, title: string, sourceType: string | null) {
    setDismissTarget({ id: taskId, title, sourceType });
  }

  const snoozeTask = snoozeTaskId ? suggestions.find((s) => s.id === snoozeTaskId) : null;

  const body = loading ? (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
    </div>
  ) : (
    <div className="space-y-4">
      {/* Plan assignments awaiting my accept/decline */}
      <PlanProposals locale={locale} onChanged={() => { onUpdate?.(); }} />

      {suggestions.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Bell className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>{t("noSuggestions")}</p>
        </div>
      ) : (
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
            const isSelected = selected.has(task.id);
            const isFocused = task.id === focusId;

            return (
              <Card
                key={task.id}
                ref={isFocused ? focusNodeRef : undefined}
                className={cn(
                  "relative",
                  isFocused
                    ? "ring-2 ring-status-warn animate-pulse"
                    : isSelected
                    ? "ring-2 ring-primary/50"
                    : undefined,
                )}
              >
                {/* Source chip — pinned to the card's top-LEFT corner, deep
                    link to the original message. */}
                {source && (
                  <span className="absolute top-2 left-2 z-10">
                    <SourceLink source={source} stopPropagation />
                  </span>
                )}
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(task.id)}
                      className="mt-1.5 shrink-0 h-4 w-4 cursor-pointer"
                      aria-label={t("selectAll")}
                    />
                    {/* Clicking the body (not the inline toggles) opens the
                        edit window — the ✨/AI panel lives there now, not here. */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => setEditTask(task)}
                    >
                      {/* Title row: title + size + 🏠 + deadline. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium" dir="auto">{title}</h4>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleSizeToggle(task); }}
                          title={task.size === "quick" ? tTasks("row.sizeQuickHint") : tTasks("row.sizeRegularHint")}
                          className={cn(
                            "flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[10px] font-semibold transition-colors",
                            task.size === "quick"
                              ? "bg-status-warn-bg text-status-warn"
                              : "bg-secondary text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Zap className="h-3 w-3" />
                          {task.size === "quick" ? tTasks("row.sizeQuick") : tTasks("row.sizeRegular")}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleHomeToggle(task); }}
                          title={tTasks("contextFilter.home")}
                          aria-pressed={task.context === "home"}
                          className={cn(
                            "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                            task.context === "home"
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground/40 hover:text-muted-foreground",
                          )}
                        >
                          <Home className="h-3.5 w-3.5" />
                        </button>
                        <span onClick={(e) => e.stopPropagation()}>
                          <DueDateChip
                            deadline={effectiveDeadline(task)}
                            locale={locale}
                            blocked={blocked}
                            onChange={(d) => handleDueChange(task.id, d)}
                          />
                        </span>
                      </div>
                      {task.description ? (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words" dir="auto">
                          {task.description}
                        </p>
                      ) : null}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {task.related_contact && (
                          <Badge variant="outline" className="text-[10px]">
                            {task.related_contact}
                          </Badge>
                        )}
                        {(task.tags ?? []).slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[10px] capitalize">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>

                  <SuggestionActions
                    infoProjectId={task.project_id}
                    infoTitle={title}
                    infoBody={task.description}
                    onFastDismiss={() => handleFastDismiss(task.id)}
                    onDismissWithReason={() => openDismissDialog(task.id, title, source?.source_type ?? null)}
                    onApprove={() => handleApprove(task.id)}
                    onSnooze={() => setSnoozeTaskId(task.id)}
                    onComplete={() => handleComplete(task.id)}
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
        onDismissed={() => { fetchSuggestions(); onUpdate?.(); }}
      />

      <TaskDetail
        task={editTask}
        locale={locale}
        open={!!editTask}
        onClose={() => setEditTask(null)}
        onUpdate={fetchSuggestions}
        initialEditingFields
      />

      <SnoozeDialog
        open={!!snoozeTaskId}
        onClose={() => setSnoozeTaskId(null)}
        onConfirm={handleSnoozeConfirm}
        maxDate={snoozeTask ? effectiveDeadline(snoozeTask) : null}
      />

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
 * Per-card action row, in RTL display order from start to end:
 *   snooze · save-as-info · [flex] · fast-X (red) · X! (orange) · approve · done
 *
 * There is no edit button — clicking the card body opens the edit window.
 * "approve" moves the suggestion into the task lists (waiting, or straight to
 * the desk when the deadline is near). "done" closes it in one step.
 */
function SuggestionActions({
  infoProjectId,
  infoTitle,
  infoBody,
  onFastDismiss,
  onDismissWithReason,
  onApprove,
  onSnooze,
  onComplete,
}: {
  infoProjectId: string | null;
  infoTitle: string;
  infoBody: string | null;
  onFastDismiss: () => void;
  onDismissWithReason: () => void;
  onApprove: () => void;
  onSnooze: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");

  return (
    <div className="flex gap-2 mt-3 items-center">
      <Button
        size="icon"
        variant="ghost"
        className="h-9 w-9"
        onClick={onSnooze}
        title={tTasks("actions.snooze")}
        aria-label={tTasks("actions.snooze")}
      >
        <Clock className="h-4 w-4" />
      </Button>
      <SaveAsInfoButton
        defaultProjectId={infoProjectId}
        defaultTitle={infoTitle}
        defaultBody={infoBody}
      />
      <div className="flex-1" />
      <Button
        size="icon"
        variant="ghost"
        className="h-9 w-9 text-status-late hover:bg-status-late-bg"
        onClick={onFastDismiss}
        title={t("fastDismiss")}
        aria-label={t("fastDismiss")}
      >
        <X className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-9 w-9 text-status-warn hover:bg-status-warn-bg font-semibold"
        onClick={onDismissWithReason}
        title={t("dismissWithReason")}
        aria-label={t("dismissWithReason")}
      >
        <X className="h-4 w-4" />
        <span className="text-sm leading-none -ms-0.5">!</span>
      </Button>
      <Button
        size="icon"
        className="h-9 w-9"
        onClick={onApprove}
        title={t("approve")}
        aria-label={t("approve")}
      >
        <CheckCircle2 className="h-4 w-4" />
      </Button>
      {/* The unified ✓ — same affordance as task rows: complete in one step,
          with an undo toast. Replaces the old labeled "complete" button. */}
      <button
        type="button"
        onClick={onComplete}
        title={tTasks("actions.complete")}
        aria-label={tTasks("actions.complete")}
        className="flex h-9 w-9 items-center justify-center"
      >
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md border-2 border-muted-foreground/40 text-[12px] text-transparent transition-colors hover:border-status-ok hover:text-status-ok">
          ✓
        </span>
      </button>
    </div>
  );
}
