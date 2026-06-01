"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, X, Bell, Pencil, Clock } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { formatDateOnly } from "@/lib/date";
import { useAITrail, AITrailIconButton, AITrailBody } from "@/components/smrttask/common/AITrail";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { DismissDialog } from "./DismissDialog";
import { MergeModal, type MergeMinimizeJob } from "@/components/smrttask/merge/MergeModal";
import { useMergeJob, useMergeCompletedListener } from "@/contexts/MergeJobContext";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { SmartSearch } from "@/components/smrttask/tasks/SmartSearch";
import { TaskDetail } from "@/components/smrttask/tasks/TaskDetail";
import type { Task } from "@/types/task";

interface SourceJoin {
  source_type: string | null;
  source_url: string | null;
  serial_display: string | null;
  metadata?: { rfc822MsgId?: string | null } | null;
}

export function MessageSuggestions({ locale, onUpdate }: { locale: string; onUpdate?: () => void }) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const tMerge = useTranslations("merge");
  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string; sourceType: string | null } | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [snoozeTaskId, setSnoozeTaskId] = useState<string | null>(null);
  // searchResults: null = no active search, [] = search returned nothing,
  // otherwise the SmartSearch matches scoped to this list (inbox + unverified).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
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
  // suggestion card into view and briefly highlight it. The ref lets us
  // attach a node to the focus target after render.
  const focusId = searchParams.get("focus");
  const focusedRef = useRef<string | null>(null);
  const focusNodeRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the first load has completed. Subsequent refetches
  // (triggered by save/approve/dismiss → onUpdate) must NOT flip the
  // global `loading` flag, because that unmounts the open <TaskDetail>
  // sheet — and on remount the auto-edit effect re-fires against the
  // stale `editTask` prop, making the form snap back to pre-save values.
  const initialLoadDoneRef = useRef(false);

  const fetchSuggestions = useCallback(async () => {
    if (!initialLoadDoneRef.current) setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    const { data, count } = await supabase
      .from("tasks")
      // projects(...) is needed so the edit-button TaskDetail sheet can
      // show the linked project chip; without the join it silently
      // disappears in the editor.
      .select("*, source_messages(source_type, source_url, serial_display, metadata), projects(id, name, name_he, color, parent_id)", { count: "exact" })
      .eq("user_id", user.id)
      .eq("status", "inbox")
      .eq("manually_verified", false)
      .not("source_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000);  // PostgREST default cap; the user wants to see every pending suggestion

    // Show newest-first by creation order. Previously we re-sorted by
    // priority client-side, which pinned old urgent items to the top and
    // hid fresh suggestions below them. Priority is still visible as a
    // badge on each card.
    const sorted = (data || []) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    setSuggestions(sorted);
    setTotalCount(count ?? sorted.length);
    setSelected(new Set());
    // Re-bind editTask to the freshly fetched row so an open TaskDetail
    // sheet renders the saved values instead of the pre-save snapshot.
    // If the row no longer matches the suggestion filter (e.g. user
    // changed status away from "inbox" inside the edit form), clear
    // editTask — the sheet closes naturally via open={!!editTask}.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setEditTask((prev) => (prev ? ((sorted as any[]).find((s: any) => s.id === prev.id) as Task | undefined) ?? null : null));
    initialLoadDoneRef.current = true;
    setLoading(false);
    // Nudge the sidebar to refetch its counters. The supabase Realtime
    // subscription on tasks should also catch the underlying mutations,
    // but firing a local event guarantees an instant update on the
    // user's own actions without waiting for the round-trip.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("smrtesy:badge-refresh"));
    }
  }, [supabase]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  // Scroll-to-focus when the inbox page is opened via a /whatsapp link
  // like /he/inbox?focus=<task_id>. Runs once per focus id; cleans the
  // URL after so a manual reload doesn't keep re-scrolling.
  useEffect(() => {
    if (!focusId || loading) return;
    if (focusedRef.current === focusId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exists = suggestions.some((s: any) => s.id === focusId);
    if (!exists) return;
    focusedRef.current = focusId;
    // Wait a frame for the DOM to settle before scrolling.
    requestAnimationFrame(() => {
      focusNodeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const params = new URLSearchParams(searchParams.toString());
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [focusId, loading, suggestions, pathname, router, searchParams]);

  // When SmartSearch is active, displayed rows come from it. Otherwise we show
  // the regularly-fetched suggestion list. SmartSearch is scoped to the same
  // filter as fetchSuggestions (status=inbox, manually_verified=false,
  // source_message_id NOT NULL) via its refineQuery prop below, so the two
  // sources are interchangeable from a row-shape perspective.
  const displayed = searchResults ?? suggestions;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(displayed.map((t: any) => t.id as string))); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  function clearSelection() { setSelected(new Set()); }

  async function handleApprove(taskId: string) {
    const { error } = await supabase
      .from("tasks")
      .update({ manually_verified: true, seen_at: new Date().toISOString() })
      .eq("id", taskId);
    if (error) { toast.error(error.message); return; }
    toast.success(t("approve"));
    fetchSuggestions();
    onUpdate?.();
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
      toast.success(tTasks("actions.complete"));
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

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Bell className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noSuggestions")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Server-side search, same UX as the Tasks page.
          The query is scoped to the suggestion filter (inbox + unverified +
          has source_message) and pulls the same joined columns as
          fetchSuggestions so search results render identically to the
          un-searched list. */}
      <SmartSearch
        onResults={(results) => setSearchResults(results.length > 0 ? results : null)}
        selectClause="*, source_messages(source_type, source_url, serial_display, metadata), projects(id, name, name_he, color, parent_id)"
        refineQuery={(q) => q
          .eq("status", "inbox")
          .eq("manually_verified", false)
          .not("source_message_id", "is", null)
        }
        hideArchiveToggle
      />

      <SuggestionToolbar
        total={totalCount || suggestions.length}
        filtered={displayed.length}
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

      {displayed.length === 0 && (
        <div className="py-8 text-center text-muted-foreground text-sm">
          {t("noSuggestions")}
        </div>
      )}

      {displayed.map((task: any) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
        const source = (Array.isArray(task.source_messages) ? task.source_messages[0] : task.source_messages) as SourceJoin | null;
        const title = locale === "he" && task.title_he ? task.title_he : task.title;
        // YYYY-MM-DD parsed via new Date() lands at UTC midnight and shifts back a
        // day in negative UTC offsets — same bug TaskCard fixed in 29484ef.
        const dueDate = task.due_date
          ? formatDateOnly(task.due_date as string, locale, { day: "numeric", month: "short" })
          : null;
        const isSelected = selected.has(task.id);
        const isFocused = task.id === focusId;

        return (
          <Card
            key={task.id}
            ref={isFocused ? focusNodeRef : undefined}
            className={
              isFocused
                ? "ring-2 ring-amber-400 animate-pulse"
                : isSelected
                ? "ring-2 ring-primary/50"
                : undefined
            }
          >
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(task.id as string)}
                  className="mt-2 shrink-0 h-4 w-4 cursor-pointer"
                  aria-label={t("selectAll")}
                />
                <div className="mt-1 rounded-full bg-blue-100 p-2">
                  <Bell className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-sm" dir={locale === "he" ? "rtl" : "ltr"}>{title}</h4>
                    <SerialBadge serial={task.serial_display as string | null} />
                    <SourceLink source={source} />
                    {dueDate && (
                      <Badge variant="outline" className="text-[10px] bg-blue-50 shrink-0">
                        {dueDate}
                      </Badge>
                    )}
                  </div>
                  {task.description ? (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words" dir={locale === "he" ? "rtl" : "ltr"}>
                      {task.description}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {task.related_contact && (
                      <Badge variant="outline" className="text-[10px]">
                        {task.related_contact as string}
                      </Badge>
                    )}
                    {task.priority && (
                      <Badge variant="secondary" className="text-[10px]">
                        {tTasks(`priority.${task.priority}`)}
                      </Badge>
                    )}
                    {(task.tags as string[] | null)?.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] capitalize">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              <SuggestionActions
                taskId={task.id as string}
                infoProjectId={(task.project_id as string | null) ?? null}
                infoTitle={title as string}
                infoBody={(task.description as string | null) ?? null}
                onFastDismiss={() => handleFastDismiss(task.id as string)}
                onDismissWithReason={() => openDismissDialog(task.id as string, (locale === "he" && task.title_he ? task.title_he : task.title) as string, source?.source_type ?? null)}
                onApprove={() => handleApprove(task.id as string)}
                onEdit={() => setEditTask(task as Task)}
                onSnooze={() => setSnoozeTaskId(task.id as string)}
                onComplete={() => handleComplete(task.id as string)}
              />
            </CardContent>
          </Card>
        );
      })}

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
    </div>
  );
}

/**
 * Per-card action row, in RTL display order from start to end:
 *   AI trail · edit · snooze · [flex] · fast-X (red) · X! (orange) · approve · done
 *
 * "approve" moves the suggestion into the active task list. "done" (green,
 * matching the TaskCard complete button) marks the task as completed in one
 * step — for users who want to log an immediate task and close it without
 * the intermediate inbox stage.
 */
function SuggestionActions({
  taskId,
  infoProjectId,
  infoTitle,
  infoBody,
  onFastDismiss,
  onDismissWithReason,
  onApprove,
  onEdit,
  onSnooze,
  onComplete,
}: {
  taskId: string;
  infoProjectId: string | null;
  infoTitle: string;
  infoBody: string | null;
  onFastDismiss: () => void;
  onDismissWithReason: () => void;
  onApprove: () => void;
  onEdit: () => void;
  onSnooze: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const trail = useAITrail(taskId);

  return (
    <>
      <div className="flex gap-2 mt-3 items-center">
        <AITrailIconButton open={trail.open} onToggle={trail.toggle} />
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          onClick={onEdit}
          title={tCommon("edit")}
          aria-label={tCommon("edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
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
          className="h-9 w-9 text-red-500 hover:text-red-600 hover:bg-red-50"
          onClick={onFastDismiss}
          title={t("fastDismiss")}
          aria-label={t("fastDismiss")}
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 text-orange-500 hover:text-orange-600 hover:bg-orange-50 font-semibold"
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
        <Button
          size="sm"
          variant="ghost"
          className="h-9 gap-1 text-green-600/40 hover:text-white hover:bg-green-600 active:bg-green-700"
          onClick={onComplete}
          title={tTasks("actions.complete")}
          aria-label={tTasks("actions.complete")}
        >
          <CheckCircle2 className="h-4 w-4" />
          <span className="hidden md:inline">{tTasks("actions.complete")}</span>
        </Button>
      </div>

      {trail.open && (
        <AITrailBody
          data={trail.data}
          loading={trail.loading}
          error={trail.error}
          className="mt-2"
        />
      )}
    </>
  );
}
