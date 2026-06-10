"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Bell, Clock, Zap, Home, ThumbsDown, ListPlus, Check } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { CombinedSearch } from "@/components/smrttask/common/CombinedSearch";
import { DueDateChip } from "@/components/smrttask/tasks/DueDateChip";
import { ContextButton } from "@/components/smrttask/tasks/ContextPanel";
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
                      {title}
                    </h4>
                    <div dir="ltr" className="flex shrink-0 items-center gap-1">
                      {source && <SourceLink source={source} stopPropagation />}
                      <DueDateChip
                        deadline={effectiveDeadline(task)}
                        locale={locale}
                        blocked={blocked}
                        onChange={(d) => handleDueChange(task.id, d)}
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

                  {(task.related_contact || (task.tags ?? []).length > 0) && (
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
                  )}

                  <SuggestionActions
                    task={task}
                    locale={locale}
                    infoProjectId={task.project_id}
                    infoTitle={title}
                    infoBody={task.description}
                    onSizeToggle={() => handleSizeToggle(task)}
                    onHomeToggle={() => handleHomeToggle(task)}
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
  onSizeToggle,
  onHomeToggle,
  onFastDismiss,
  onDismissWithReason,
  onApprove,
  onSnooze,
  onComplete,
}: {
  task: Task;
  locale: string;
  infoProjectId: string | null;
  infoTitle: string;
  infoBody: string | null;
  onSizeToggle: () => void;
  onHomeToggle: () => void;
  onFastDismiss: () => void;
  onDismissWithReason: () => void;
  onApprove: () => void;
  onSnooze: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const isQuick = task.size === "quick";
  const isHome = task.context === "home";

  return (
    <div className="flex gap-1 mt-3 items-center flex-wrap">
      {/* ── meta ───────────────────────────────────────────────────────── */}
      <ContextButton task={task} locale={locale} className="h-9 w-9 md:h-8 md:w-8 [&_svg]:size-4" />
      <IconButton
        label={isQuick ? tTasks("row.sizeQuickHint") : tTasks("row.sizeRegularHint")}
        color="amber"
        className={isQuick ? "text-status-warn" : undefined}
        onClick={onSizeToggle}
      >
        <Zap className={isQuick ? "fill-current" : undefined} />
      </IconButton>
      <IconButton
        label={tTasks("contextFilter.home")}
        color="primary"
        className={isHome ? "text-primary" : undefined}
        aria-pressed={isHome}
        onClick={onHomeToggle}
      >
        <Home className={isHome ? "fill-current" : undefined} />
      </IconButton>
      <IconButton label={tTasks("actions.snooze")} color="amber" onClick={onSnooze}>
        <Clock />
      </IconButton>
      <SaveAsInfoButton
        defaultProjectId={infoProjectId}
        defaultTitle={infoTitle}
        defaultBody={infoBody}
      />

      <div className="flex-1" />

      {/* ── decide ─────────────────────────────────────────────────────── */}
      <IconButton label={t("fastDismiss")} color="red" onClick={onFastDismiss}>
        <X />
      </IconButton>
      <IconButton label={t("dismissWithReason")} color="violet" onClick={onDismissWithReason}>
        <ThumbsDown />
      </IconButton>
      <IconButton label={t("approve")} color="blue" onClick={onApprove}>
        <ListPlus />
      </IconButton>
      <IconButton label={tTasks("actions.complete")} color="green" onClick={onComplete}>
        <Check />
      </IconButton>
    </div>
  );
}
