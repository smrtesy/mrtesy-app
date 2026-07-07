"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Zap,
  FolderSearch,
  Clock,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  X,
  Home,
  MapPin,
  Trash2,
  ThumbsDown,
  ListPlus,
  CalendarPlus,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { translateActionLabel } from "@/lib/actionLabels";
import { LinkifiedText } from "@/components/smrttask/common/LinkifiedText";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { ClaudeLauncher } from "@/components/smrttask/tasks/ClaudeLauncher";
import { ContextButton } from "@/components/smrttask/tasks/ContextPanel";
import { DueDateChip } from "@/components/smrttask/tasks/DueDateChip";
import { AssigneeButton } from "@/components/smrttask/tasks/AssigneeButton";
import { TaskChecklist } from "@/components/smrttask/tasks/TaskChecklist";
import { TaskMaterials } from "@/components/smrttask/tasks/TaskMaterials";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { AddEventModal } from "@/components/smrttask/tasks/AddEventModal";
import { MergeModal } from "@/components/smrttask/merge/MergeModal";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { effectiveDeadline } from "@/lib/workdays";
import type { Task } from "@/types/task";

interface TaskDetailProps {
  task: Task | null;
  locale: string;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
  onDelete?: (taskId: string) => void;
  onQuickAction?: (taskId: string, action: { label: string; prompt: string }) => void;
  onDriveSearch?: (taskId: string, description: string) => void;
  /** Legacy — the editor is now always on; accepted so callers stay unchanged. */
  initialEditingFields?: boolean;
  /**
   * Suggestion-mode decide cluster: when these are provided (the inbox), the
   * footer shows ✗ dismiss · 👎 dismiss+learn · ＋ convert · ✓ done — exactly
   * like the card outside. Without them (the tasks page) it shows 🗑 + ✓.
   */
  onFastDismiss?: (taskId: string) => void;
  onDismissWithReason?: (taskId: string) => void;
  onApprove?: (taskId: string) => void;
}

// onQuickAction/onDriveSearch are accepted (and ignored) while those features
// are hidden — callers stay unchanged for when they return.
export function TaskDetail({ task, locale, open, onClose, onUpdate, onDelete, onFastDismiss, onDismissWithReason, onApprove }: TaskDetailProps) {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const tDetail = useTranslations("taskDetailExt");
  const tActions = useTranslations("tasks.actions");
  const tMerge = useTranslations("merge");
  const tSuggestions = useTranslations("suggestions");
  const tEvents = useTranslations("events");
  const blocked = useWorkCalendar();

  // Description edit
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState("");

  // Task field edit — autosaved (debounced); no save buttons anywhere.
  const [editingFields, setEditingFields] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSize, setEditSize] = useState<"quick" | "regular">("regular");
  const [editContext, setEditContext] = useState<"" | "home" | "outside">("");
  const [editAssignedTo, setEditAssignedTo] = useState<string>("");
  // Lazily loaded when edit mode first opens
  /** Tiny "saved ✓" flash after an autosave lands. */
  const [savedFlash, setSavedFlash] = useState(false);
  /** Suppresses the autosave effect while the form is being (re)seeded. */
  const seedingRef = useRef(false);
  const fieldsTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const descTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** True once any autosave happened — the parent list refreshes on close. */
  const dirtyRef = useRef(false);

  const [newUpdate, setNewUpdate] = useState("");
  const [addingUpdate, setAddingUpdate] = useState(false);
  /** IDs of update entries the user clicked to expand. Long content is
   *  truncated by default; click to see the full body. */
  const [expandedUpdateIds, setExpandedUpdateIds] = useState<Set<string>>(new Set());
  const [showGenerated, setShowGenerated] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  // Snooze opens the picker dialog; actual API call lives in handleSnoozeConfirm.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [addEventOpen, setAddEventOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [dismissingDup, setDismissingDup] = useState(false);

  /** Locally-refreshed snapshot of the task, kept in sync after operations
   *  that the parent's onUpdate() callback only refreshes at list-level
   *  (e.g. adding an update doesn't push a new `task` prop down). When
   *  set, takes precedence over the prop so the user sees their note
   *  appear immediately. Cleared when the prop's task.id changes. */
  const [liveTask, setLiveTask] = useState<Task | null>(null);

  // The editor (title + footer toggles) is ALWAYS on — there is no pencil.
  // Seed it whenever the dialog opens for a (possibly different) task.
  const autoEditedTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoEditedTaskIdRef.current = null;
      return;
    }
    if (!task) return;
    if (autoEditedTaskIdRef.current === task.id) return;
    autoEditedTaskIdRef.current = task.id;
    startFieldEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  // Reset the local override whenever the parent opens us with a
  // different task so we don't bleed state across selections.
  const lastTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastTaskIdRef.current !== (task?.id ?? null)) {
      lastTaskIdRef.current = task?.id ?? null;
      setLiveTask(null);
    }
  }, [task?.id]);

  /** Debounced autosave of the field editor — fires ~1.2s after the last
   *  change. Deliberately does NOT call onUpdate() per save (a list refetch
   *  mid-typing would snap the form back); the parent refreshes on close. */
  useEffect(() => {
    if (!editingFields || seedingRef.current || !task) return;
    if (fieldsTimerRef.current) clearTimeout(fieldsTimerRef.current);
    const taskId = task.id;
    const isPlan = !!task.plan_id;
    fieldsTimerRef.current = setTimeout(async () => {
      const body: Record<string, unknown> = {
        size: editSize,
        context: editContext || null,
        assigned_to_user_id: editAssignedTo || null,
      };
      // due_date is edited via the header chip (its own PATCH), not here.
      void isPlan;
      if (editTitle.trim()) {
        if (locale === "he") body.title_he = editTitle.trim();
        else                 body.title = editTitle.trim();
      }
      try {
        const { task: fresh } = await api<{ task: Task }>(`/api/tasks/${taskId}`, { method: "PATCH", body });
        dirtyRef.current = true;
        if (fresh) setLiveTask(fresh);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Error");
      }
    }, 1200);
    return () => { if (fieldsTimerRef.current) clearTimeout(fieldsTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTitle, editSize, editContext, editAssignedTo, editingFields]);

  /** Debounced autosave for the description — same contract as the fields. */
  useEffect(() => {
    if (!editingDesc || !task) return;
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    const taskId = task.id;
    descTimerRef.current = setTimeout(async () => {
      try {
        const { task: fresh } = await api<{ task: Task }>(`/api/tasks/${taskId}`, { method: "PATCH", body: { description } });
        dirtyRef.current = true;
        if (fresh) setLiveTask(fresh);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Error");
      }
    }, 1200);
    return () => { if (descTimerRef.current) clearTimeout(descTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, editingDesc]);

  if (!task) return null;

  // Resolve which view of the task we're rendering. liveTask wins when
  // it's for the currently-open task; otherwise we trust the parent prop.
  const effectiveTask: Task = liveTask && liveTask.id === task.id ? liveTask : task;

  const title = locale === "he" && effectiveTask.title_he ? effectiveTask.title_he : effectiveTask.title;
  const updates = (effectiveTask.updates || []).slice(-20).reverse();
  const generated = effectiveTask.ai_generated_content || [];
  const docs = effectiveTask.linked_drive_docs || [];

  // Dismiss a medium-confidence duplicate suggestion ("not a duplicate"):
  // clears the pointer so the banner stops showing.
  async function dismissDuplicateSuggestion() {
    if (!task) return;
    setDismissingDup(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { suggested_duplicate_of: null } });
      toast.success(t("duplicateSuggestionDismissed"));
      onUpdate();
    } catch {
      toast.error(tCommon("error"));
    } finally {
      setDismissingDup(false);
    }
  }

  function startFieldEdit() {
    if (!task) return;
    seedingRef.current = true;
    setEditTitle(locale === "he" ? task.title_he || task.title : task.title);
    setEditSize(task.size === "quick" ? "quick" : "regular");
    setEditContext(task.context === "home" ? "home" : task.context === "outside" ? "outside" : "");
    setEditAssignedTo(task.assigned_to_user_id || "");
    setEditingFields(true);
    // Let the seeded values settle before the autosave watcher arms.
    requestAnimationFrame(() => { seedingRef.current = false; });
    // The member list is loaded lazily by AssigneeButton itself.
  }

  function handleDialogClose() {
    // One list refresh for the whole edit session, after typing is done.
    if (dirtyRef.current) {
      dirtyRef.current = false;
      onUpdate();
    }
    onClose();
  }

  async function handleComplete() {
    if (!task) return;
    try {
      await api(`/api/tasks/${task.id}/complete`, { method: "POST" });
      toast.success(t("actions.complete"));
      onClose();
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  function handleSnooze() {
    if (!task) return;
    setSnoozeOpen(true);
  }

  async function handleSnoozeConfirm(untilIso: string) {
    if (!task) return;
    try {
      await api(`/api/tasks/${task.id}/snooze`, {
        method: "POST",
        body: { until: untilIso },
      });
      toast.success(t("actions.snooze"));
      onClose();
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleAddUpdate() {
    if (!task || !newUpdate.trim()) return;
    setAddingUpdate(true);
    try {
      const { update } = await api<{ update: NonNullable<Task["updates"]>[number] }>(
        `/api/tasks/${task.id}/updates`,
        { method: "POST", body: { content: newUpdate.trim(), type: "note" } },
      );
      toast.success(tDetail("toastUpdateAdded"));
      setNewUpdate("");
      // Optimistic local update so the new entry appears in the timeline
      // immediately, without waiting for the parent to refetch + re-pass
      // the task prop (which most callers don't do for the open detail).
      setLiveTask((prev) => {
        const base = prev && prev.id === task.id ? prev : task;
        return {
          ...base,
          updates: [...(base.updates ?? []), update],
        };
      });
      onUpdate();
      // The server refreshes title + description from the new update via Haiku
      // (fire-and-forget, ~1-3s). Pull the task once after a short delay so the
      // open panel shows the refreshed title/description without a manual reopen.
      const refreshId = task.id;
      window.setTimeout(async () => {
        try {
          const { task: fresh } = await api<{ task: Task }>(`/api/tasks/${refreshId}`);
          if (fresh) {
            setLiveTask((prev) => (prev && prev.id === refreshId ? { ...prev, title: fresh.title, title_he: fresh.title_he, description: fresh.description } : prev));
            dirtyRef.current = true;
          }
        } catch { /* best-effort */ }
      }, 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setAddingUpdate(false);
    }
  }

  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleDialogClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="app-dialog-overlay fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          dir={dir}
          className={cn(
            // Centered modal, desktop. `app-dialog-content` lets globals.css
            // re-center it into the main-content half when the WhatsApp panel
            // is docked, so the panel never covers it.
            "app-dialog-content fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
            "w-full sm:max-w-2xl max-h-[92vh]",
            "flex flex-col bg-background border shadow-xl rounded-lg overflow-hidden",
            // Full screen on small screens
            "max-sm:!left-0 max-sm:!top-0 max-sm:!translate-x-0 max-sm:!translate-y-0",
            "max-sm:!w-full max-sm:!max-w-full max-sm:!max-h-full max-sm:!h-screen max-sm:!rounded-none",
            // Animations
            "duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          {/* Sticky header — the full title gets row 1 on its own; the X and
              the serial/source/date chips drop to row 2. ALL action icons live
              in the bottom row, mirroring the cards. */}
          <div className="sticky top-0 z-10 bg-background border-b px-4 py-3 space-y-1.5">
            {/* Row 1: the full title alone — no truncation, so a long title
                wraps and stays fully readable. */}
            <DialogTitle className="text-start text-base" dir={dir}>{title}</DialogTitle>
            {/* Row 2: serial (T42/G127/…) + source + editable due date — same
                cluster as on the cards — plus savedFlash and the close X pushed
                to the trailing edge. The serial is click-to-copy so the user
                can paste it into chat ("what happened to T42?"). */}
            <div className="flex items-center gap-2">
              <div dir="ltr" className="flex min-w-0 items-center gap-1.5">
                <SerialBadge serial={effectiveTask.serial_display} stopPropagation />
                {effectiveTask.source_messages && <SourceLink source={effectiveTask.source_messages} stopPropagation onNavigate={handleDialogClose} />}
                <DueDateChip
                  deadline={effectiveDeadline(effectiveTask)}
                  time={effectiveTask.due_date ? effectiveTask.due_time : null}
                  blocked={blocked}
                  locked={!!effectiveTask.plan_id}
                  onChange={effectiveTask.plan_id ? undefined : (d, tm) => {
                    // A due date with a time is an event (task_type=meeting);
                    // clearing the time reverts an event back to a plain task.
                    const body: Record<string, unknown> = { due_date: d, due_time: tm };
                    if (d && tm) body.task_type = "meeting";
                    else if (effectiveTask.task_type === "meeting") body.task_type = "action";
                    api(`/api/tasks/${effectiveTask.id}`, { method: "PATCH", body })
                      .then(() => { dirtyRef.current = true; setLiveTask((p) => p ? { ...p, ...body } as Task : p); })
                      .catch((e) => toast.error((e as Error).message));
                  }}
                />
              </div>
              {savedFlash && (
                <span className="text-[10px] text-status-ok">{tDetail("savedFlash")}</span>
              )}
              <div className="flex-1" />
              <IconButton label={tCommon("close")} color="neutral" onClick={handleDialogClose}>
                <X />
              </IconButton>
            </div>
          </div>

          {/* Cross-source duplicate suggestion (medium confidence). High-confidence
              matches are auto-linked upstream and never reach here. */}
          {effectiveTask.suggested_duplicate_of && effectiveTask.suggested_duplicate && (
            <div className="border-b bg-status-warn-bg px-4 py-2.5 flex items-center gap-2 text-sm" dir={dir}>
              <div className="flex-1 min-w-0 text-status-warn">
                {t("duplicateSuggestionLabel", { serial: effectiveTask.suggested_duplicate.serial_display })}
                <span className="block truncate text-xs opacity-80">
                  {locale === "he"
                    ? (effectiveTask.suggested_duplicate.title_he ?? effectiveTask.suggested_duplicate.title)
                    : (effectiveTask.suggested_duplicate.title ?? effectiveTask.suggested_duplicate.title_he)}
                </span>
              </div>
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => setMergeOpen(true)}>
                {t("duplicateSuggestionReview")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 shrink-0" disabled={dismissingDup} onClick={dismissDuplicateSuggestion}>
                {t("duplicateSuggestionDismiss")}
              </Button>
            </div>
          )}

          {/* Plain overflow-y-auto instead of <ScrollArea> here. The Radix
              viewport occasionally fails to size correctly inside this
              dialog when the inner content has its own border/overflow
              wrappers (the unified description+updates block does), which
              leaves the body un-scrollable — the user can see content
              below the fold but can't reach it. Native scrolling is the
              robust fallback and gives touch devices momentum out of the
              box. */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 overscroll-contain">
            <div className="space-y-4">
              {/* Title — always editable, autosaved (debounced). All toggles
                  (⚡/🏠/👤/…) live in the bottom action row, like the cards. */}
              {editingFields && (
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  dir={dir}
                  className="h-8 text-sm"
                  placeholder={tDetail("titleLabel")}
                />
              )}

              {/* Description + Updates — unified block. The description
                  is the user's editable canonical text; updates are the
                  evolving timeline of what's changed/happened. Both
                  always visible so the user gets the full task story on
                  open, with no extra clicks. */}
              <div className="rounded border overflow-hidden">
                {/* Description (canonical) */}
                <div className="p-3">
                  <h4 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("detail.description")}
                  </h4>
                  {editingDesc ? (
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      onBlur={() => setEditingDesc(false)}
                      className="min-h-[120px]"
                      dir={dir}
                      autoFocus
                    />
                  ) : (
                    /* Click the text to edit — autosaved (debounced), no buttons. */
                    <div
                      className="whitespace-pre-wrap text-sm cursor-text"
                      dir={dir}
                      onClick={() => {
                        setDescription(effectiveTask.description || "");
                        setEditingDesc(true);
                      }}
                    >
                      {effectiveTask.description ? (
                        <LinkifiedText>{effectiveTask.description}</LinkifiedText>
                      ) : (
                        <span className="text-muted-foreground italic">{t("detail.editDescription")}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Updates timeline — always visible. Compact. */}
                <div className="border-t bg-muted/30">
                  {/* Quick-add input — always-visible so the user can drop
                      a note without expanding anything. */}
                  <div className="flex gap-2 p-2 border-b bg-background">
                    <Textarea
                      value={newUpdate}
                      onChange={(e) => setNewUpdate(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter saves (Shift+Enter for a newline) — no save button.
                        if (e.key === "Enter" && !e.shiftKey && !addingUpdate && newUpdate.trim()) {
                          e.preventDefault();
                          handleAddUpdate();
                        }
                      }}
                      placeholder={tDetail("addUpdatePlaceholder")}
                      className="min-h-[40px] text-sm resize-none flex-1"
                      dir={dir}
                      rows={1}
                    />
                  </div>

                  {/* Timeline */}
                  {updates.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic px-3 py-2">
                      {t("detail.noUpdates")}
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {updates.map((update) => {
                        const isLong = (update.content?.length ?? 0) > 140;
                        const expanded = expandedUpdateIds.has(update.id);
                        const display = !isLong || expanded
                          ? update.content
                          : (update.content ?? "").slice(0, 140) + "…";
                        return (
                          <li
                            key={update.id}
                            className="px-3 py-1.5 text-sm md:text-xs hover:bg-background/60 transition-colors"
                          >
                            <div className="flex items-baseline gap-2 text-[11px] md:text-[10px] text-muted-foreground mb-0.5">
                              <span className="font-medium" title={new Date(update.created_at).toLocaleString()}>
                                {formatUpdateTime(update.created_at, locale)}
                              </span>
                              <span>·</span>
                              <span>{formatActor(update.actor, update.type, locale)}</span>
                            </div>
                            <div
                              className="whitespace-pre-wrap leading-snug"
                              dir={dir}
                              onClick={() => {
                                if (!isLong) return;
                                setExpandedUpdateIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(update.id)) next.delete(update.id);
                                  else next.add(update.id);
                                  return next;
                                });
                              }}
                              style={{ cursor: isLong ? "pointer" : "default" }}
                            >
                              <LinkifiedText>{display}</LinkifiedText>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              <Separator />

              {/* Checklist (subtasks) — persisted as task.checklist JSONB array */}
              <TaskChecklist
                taskId={task.id}
                items={task.checklist ?? []}
                onChange={onUpdate}
              />

              {/* AI action buttons ("משימות לביצוע") are hidden for now —
                  the feature still needs development. Restore from git
                  history (translateActionLabel + onQuickAction) when ready. */}

              {/* Updates moved inline into the description block above. */}

              {/* Generated Content */}
              {generated.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowGenerated(!showGenerated)}
                    className="flex w-full items-center justify-between py-2 text-sm font-medium"
                  >
                    {t("detail.generatedContent")} ({generated.length})
                    {showGenerated ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showGenerated && (
                    <div className="space-y-2 mt-1">
                      {generated.map((item) => (
                        <div key={item.id} className="rounded border p-2 text-xs">
                          <div className="flex justify-between mb-1">
                            <Badge variant="outline" className="text-[10px]">{translateActionLabel(item.action_label, tActions)}</Badge>
                            <span className="text-muted-foreground">
                              {new Date(item.created_at).toLocaleString()}
                            </span>
                          </div>
                          {item.result && <p className="whitespace-pre-wrap" dir={dir}>{item.result}</p>}
                          {item.draft_url && (
                            <a
                              href={item.draft_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" /> {t("detail.openDraft")}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Linked Docs */}
              {docs.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowDocs(!showDocs)}
                    className="flex w-full items-center justify-between py-2 text-sm font-medium"
                  >
                    {t("detail.linkedDocs")} ({docs.length})
                    {showDocs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showDocs && (
                    <div className="space-y-1 mt-1">
                      {docs.map((doc, i) => (
                        <a
                          key={i}
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 rounded border p-2 text-xs hover:bg-accent"
                        >
                          <FolderSearch className="h-4 w-4 text-primary" />
                          <span className="flex-1 truncate" dir={dir}>{doc.name}</span>
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Background materials — notes / links / files / contacts */}
              <TaskMaterials
                taskId={task.id}
                items={task.task_materials ?? []}
                onChange={onUpdate}
              />
            </div>
          </div>

          {/* Sticky bottom actions — EXACTLY the card's icon row:
                meta:   ℹ️/📋 context · ⚡ size · 🏠 home · ⏰ snooze · 📄 info · 👤 assign
                decide: suggestions → ✗ · 👎 · ＋ · ✓  |  tasks → 🗑 · ✓ */}
          <div className="border-t bg-background px-4 py-2 flex items-center gap-1 flex-wrap pb-[max(8px,env(safe-area-inset-bottom))]">
            <ContextButton task={effectiveTask} locale={locale} onSourceNavigate={handleDialogClose} className="h-9 w-9 md:h-8 md:w-8 [&_svg]:size-4" />
            <IconButton
              label={editSize === "quick" ? t("row.sizeQuickHint") : t("row.sizeRegularHint")}
              color="amber"
              className={editSize === "quick" ? "text-status-warn" : undefined}
              onClick={() => setEditSize(editSize === "quick" ? "regular" : "quick")}
            >
              <Zap className={editSize === "quick" ? "fill-current" : undefined} />
            </IconButton>
            <IconButton
              label={tDetail("contextHome")}
              color="primary"
              aria-pressed={editContext === "home"}
              className={editContext === "home" ? "text-primary" : undefined}
              onClick={() => setEditContext(editContext === "home" ? "" : "home")}
            >
              <Home className={editContext === "home" ? "fill-current" : undefined} />
            </IconButton>
            <IconButton
              label={tDetail("contextOutside")}
              color="primary"
              aria-pressed={editContext === "outside"}
              className={editContext === "outside" ? "text-primary" : undefined}
              onClick={() => setEditContext(editContext === "outside" ? "" : "outside")}
            >
              <MapPin className={editContext === "outside" ? "fill-current" : undefined} />
            </IconButton>
            <IconButton label={t("actions.snooze")} color="amber" onClick={handleSnooze}>
              <Clock />
            </IconButton>
            <SaveAsInfoButton
              defaultProjectId={effectiveTask.project_id}
              defaultTitle={title}
              defaultBody={effectiveTask.description}
            />
            <AssigneeButton
              assignedTo={editAssignedTo || null}
              onAssign={(uid) => setEditAssignedTo(uid ?? "")}
            />
            <IconButton label={tEvents("addEvent")} color="primary" onClick={() => setAddEventOpen(true)}>
              <CalendarPlus />
            </IconButton>
            <ClaudeLauncher
              task={effectiveTask}
              locale={locale}
              onUpdate={() => { dirtyRef.current = true; onUpdate(); }}
              onOptimistic={(patch) => setLiveTask((prev) => ({ ...(prev && prev.id === task.id ? prev : task), ...patch }))}
            />

            <div className="flex-1" />

            {onFastDismiss && onDismissWithReason && onApprove ? (
              <>
                <IconButton
                  label={tSuggestions("fastDismiss")}
                  color="red"
                  onClick={() => { onFastDismiss(task.id); onClose(); }}
                >
                  <X />
                </IconButton>
                <IconButton
                  label={tSuggestions("dismissWithReason")}
                  color="violet"
                  onClick={() => { onDismissWithReason(task.id); onClose(); }}
                >
                  <ThumbsDown />
                </IconButton>
                <IconButton
                  label={tSuggestions("approve")}
                  color="blue"
                  onClick={() => { onApprove(task.id); onClose(); }}
                >
                  <ListPlus />
                </IconButton>
              </>
            ) : (
              onDelete && (
                <IconButton
                  label={t("actions.delete")}
                  color="red"
                  onClick={() => onDelete(task.id)}
                >
                  <Trash2 />
                </IconButton>
              )
            )}
            <IconButton label={t("actions.complete")} color="green" onClick={handleComplete}>
              <Check />
            </IconButton>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      <SnoozeDialog
        open={snoozeOpen}
        onClose={() => setSnoozeOpen(false)}
        onConfirm={handleSnoozeConfirm}
      />

      {addEventOpen && (
        <AddEventModal
          taskId={effectiveTask.id}
          open={addEventOpen}
          onClose={() => setAddEventOpen(false)}
          onDone={() => { dirtyRef.current = true; onUpdate(); handleDialogClose(); }}
          locale={locale}
        />
      )}

      {effectiveTask.suggested_duplicate && (
        <MergeModal
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
          fromTasksList
          locale={locale}
          sources={[
            { id: effectiveTask.id, title: effectiveTask.title, title_he: effectiveTask.title_he, task_type: effectiveTask.task_type, status: effectiveTask.status, ai_confidence: effectiveTask.ai_confidence },
            { id: effectiveTask.suggested_duplicate.id, title: effectiveTask.suggested_duplicate.title, title_he: effectiveTask.suggested_duplicate.title_he, task_type: "action", status: "inbox" },
          ]}
          onMerged={() => {
            setMergeOpen(false);
            toast.success(tMerge("successToast"));
            onUpdate();
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}

// ── update timeline helpers ──────────────────────────────────────────────

/** Compact, RTL-aware relative timestamp.
 *  <1m → "עכשיו" / "now"
 *  <60m → "5 דק׳" / "5m"
 *  <24h → "3 שע׳" / "3h"
 *  <7d  → "2 ימים" / "2d"
 *  else → absolute date (locale-formatted) */
function formatUpdateTime(iso: string, locale: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (locale === "he") {
    if (min < 1) return "עכשיו";
    if (min < 60) return `לפני ${min} דק׳`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `לפני ${hrs} שע׳`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `לפני ${days} ימים`;
    return new Date(iso).toLocaleDateString("he-IL");
  }
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Friendly actor label. Falls back to the entry's `type` for unknown
 *  actors so a "completion_signal" / "initial" / etc. entry still shows
 *  something meaningful. */
function formatActor(actor: unknown, type: unknown, locale: string): string {
  const a = typeof actor === "string" ? actor : "";
  const tp = typeof type === "string" ? type : "";
  if (locale === "he") {
    if (a === "user")   return "אתה";
    if (a === "ai")     return "🤖 AI";
    if (a === "system") return tp === "initial" ? "📩 מקור" : "מערכת";
    return tp || "מערכת";
  }
  if (a === "user")   return "You";
  if (a === "ai")     return "🤖 AI";
  if (a === "system") return tp === "initial" ? "📩 source" : "system";
  return tp || "system";
}
