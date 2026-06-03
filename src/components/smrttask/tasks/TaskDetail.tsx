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
  MessageCircle,
  FolderSearch,
  Clock,
  CheckCircle2,
  Save,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Pencil,
  X,
  Folder,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { translateActionLabel } from "@/lib/actionLabels";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { LinkifiedText } from "@/components/smrttask/common/LinkifiedText";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { AITrail } from "@/components/smrttask/common/AITrail";
import { TaskChecklist } from "@/components/smrttask/tasks/TaskChecklist";
import { TaskMaterials } from "@/components/smrttask/tasks/TaskMaterials";
import { SnoozeDialog } from "@/components/smrttask/tasks/SnoozeDialog";
import { MergeModal } from "@/components/smrttask/merge/MergeModal";
import { ProjectCombobox } from "@/components/smrttask/tasks/ProjectCombobox";
import type { ProjectOption } from "@/components/smrttask/tasks/ProjectCombobox";
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
  /** When the sheet first opens for this task, expand the field editor immediately. */
  initialEditingFields?: boolean;
}

export function TaskDetail({ task, locale, open, onClose, onUpdate, onDelete, onQuickAction, onDriveSearch, initialEditingFields }: TaskDetailProps) {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const tDetail = useTranslations("taskDetailExt");
  const tActions = useTranslations("tasks.actions");
  const tMerge = useTranslations("merge");

  // Description edit
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState("");

  // Task field edit
  const [editingFields, setEditingFields] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const [editAssignedTo, setEditAssignedTo] = useState<string>("");
  // Lazily loaded when edit mode first opens
  const [selectorProjects, setSelectorProjects] = useState<ProjectOption[]>([]);
  const [selectorMembers, setSelectorMembers] = useState<Array<{ user_id: string; email: string | null; name: string | null }>>([]);

  const [saving, setSaving] = useState(false);
  const [newUpdate, setNewUpdate] = useState("");
  const [addingUpdate, setAddingUpdate] = useState(false);
  /** IDs of update entries the user clicked to expand. Long content is
   *  truncated by default; click to see the full body. */
  const [expandedUpdateIds, setExpandedUpdateIds] = useState<Set<string>>(new Set());
  const [showGenerated, setShowGenerated] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  // Snooze opens the picker dialog; actual API call lives in handleSnoozeConfirm.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [dismissingDup, setDismissingDup] = useState(false);

  /** Locally-refreshed snapshot of the task, kept in sync after operations
   *  that the parent's onUpdate() callback only refreshes at list-level
   *  (e.g. adding an update doesn't push a new `task` prop down). When
   *  set, takes precedence over the prop so the user sees their note
   *  appear immediately. Cleared when the prop's task.id changes. */
  const [liveTask, setLiveTask] = useState<Task | null>(null);

  // Auto-expand the field editor when the dialog opens with initialEditingFields=true.
  // The ref is reset when the dialog closes so the next open always re-triggers edit mode.
  const autoEditedTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoEditedTaskIdRef.current = null;
      return;
    }
    if (!initialEditingFields || !task) return;
    if (autoEditedTaskIdRef.current === task.id) return;
    autoEditedTaskIdRef.current = task.id;
    void startFieldEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id, initialEditingFields]);

  // Reset the local override whenever the parent opens us with a
  // different task so we don't bleed state across selections.
  const lastTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastTaskIdRef.current !== (task?.id ?? null)) {
      lastTaskIdRef.current = task?.id ?? null;
      setLiveTask(null);
    }
  }, [task?.id]);

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

  async function startFieldEdit() {
    if (!task) return;
    setEditTitle(locale === "he" ? task.title_he || task.title : task.title);
    setEditPriority(task.priority);
    setEditDueDate(task.due_date || "");
    setEditStatus(task.status);
    setEditProjectId(task.project_id || "");
    setEditAssignedTo(task.assigned_to_user_id || "");
    setEditingFields(true);
    // Fetch projects + org members for selectors (cached after first open)
    if (selectorProjects.length === 0) {
      try {
        const { projects } = await api<{ projects: ProjectOption[] }>("/api/projects");
        setSelectorProjects(projects ?? []);
      } catch { /* ignore — ProjectCombobox fetches its own data if list is empty */ }
    }
    if (selectorMembers.length === 0) {
      try {
        const { members } = await api<{ members: Array<{ user_id: string; email: string | null; name: string | null }> }>("/api/org/members");
        setSelectorMembers(members ?? []);
      } catch { /* ignore */ }
    }
  }

  async function saveFieldEdit() {
    if (!task) return;
    setSaving(true);

    const body: Record<string, unknown> = {
      priority: editPriority,
      status: editStatus,
      due_date: editDueDate || null,
      project_id: editProjectId || null,
      assigned_to_user_id: editAssignedTo || null,
    };
    if (locale === "he") body.title_he = editTitle;
    else                 body.title = editTitle;
    // Manually linking a project → mark as 100% confident
    if (editProjectId && editProjectId !== task.project_id) body.project_confidence = 1;

    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body });
      toast.success(tCommon("save"));
      setEditingFields(false);
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDescSave() {
    if (!task) return;
    setSaving(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { description } });
      toast.success(t("detail.description"));
      setEditingDesc(false);
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setAddingUpdate(false);
    }
  }

  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          dir={dir}
          className={cn(
            // Centered modal, desktop
            "fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
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
          {/* Sticky header */}
          <div className="sticky top-0 z-10 bg-background border-b px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="text-start text-base flex-1 min-w-0 truncate" dir={dir}>{title}</DialogTitle>
              <div className="flex items-center gap-1 shrink-0">
                <IconButton label={tCommon("edit")} color="primary" onClick={startFieldEdit}>
                  <Pencil />
                </IconButton>
                <IconButton label={tCommon("close")} color="neutral" onClick={onClose}>
                  <X />
                </IconButton>
              </div>
            </div>
            {/* Serial + source + linked project — all sourced from the joined data */}
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <SerialBadge serial={task.serial_display} />
              <SourceLink source={task.source_messages} />
              {task.projects && (() => {
                const proj = task.projects!;
                const projName = locale === "he" && proj.name_he ? proj.name_he : proj.name;
                const parentProj = proj.parent_id
                  ? selectorProjects.find((p) => p.id === proj.parent_id)
                  : null;
                return (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                    style={proj.color ? { borderColor: proj.color, color: proj.color } : undefined}
                  >
                    <Folder className="h-3 w-3" />
                    {parentProj && (
                      <><span className="opacity-60">{locale === "he" && parentProj.name_he ? parentProj.name_he : parentProj.name}</span><span className="opacity-60">/</span></>
                    )}
                    {projName}
                  </span>
                );
              })()}
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
              {/* AI trail — collapsed by default; lazy-fetched on first open.
                  Only shown for AI-sourced tasks (manual tasks have no trail). */}
              {task.source_message_id && (
                <AITrail taskId={task.id} />
              )}

              {/* Field Editing */}
              {editingFields && (
                <div className="space-y-3 rounded-lg border p-3 bg-muted/50">
                  <div>
                    <label className="text-xs font-medium">{tDetail("titleLabel")}</label>
                    <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} dir={dir} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium">{tDetail("priorityLabel")}</label>
                      <select
                        value={editPriority}
                        onChange={(e) => setEditPriority(e.target.value)}
                        className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                      >
                        <option value="urgent">{t("priority.urgent")}</option>
                        <option value="high">{t("priority.high")}</option>
                        <option value="medium">{t("priority.medium")}</option>
                        <option value="low">{t("priority.low")}</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium">{tDetail("statusLabel")}</label>
                      <select
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                        className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                      >
                        <option value="inbox">{t("inbox")}</option>
                        <option value="in_progress">{t("active")}</option>
                        <option value="snoozed">{t("actions.snooze")}</option>
                        <option value="archived">{t("archived")}</option>
                        <option value="dismissed">{t("dismissed")}</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium">{tDetail("dueDateLabel")}</label>
                    <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{tDetail("projectLabel")}</label>
                    <ProjectCombobox
                      value={editProjectId}
                      onChange={setEditProjectId}
                      locale={locale}
                      initialProjects={selectorProjects}
                      onProjectCreated={(p) => setSelectorProjects((prev) => [...prev, p])}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{tDetail("assignedToLabel")}</label>
                    <select
                      value={editAssignedTo}
                      onChange={(e) => setEditAssignedTo(e.target.value)}
                      className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                    >
                      <option value="">{tDetail("unassignedOption")}</option>
                      {selectorMembers.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.email
                            ? m.name ? `${m.email} (${m.name})` : m.email
                            : m.name || m.user_id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveFieldEdit} disabled={saving} className="gap-1">
                      <Save className="h-3 w-3" />
                      {saving ? "..." : tDetail("saveButton")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingFields(false)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Description + Updates — unified block. The description
                  is the user's editable canonical text; updates are the
                  evolving timeline of what's changed/happened. Both
                  always visible so the user gets the full task story on
                  open, with no extra clicks. */}
              <div className="rounded border overflow-hidden">
                {/* Description (canonical) */}
                <div className="p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {t("detail.description")}
                    </h4>
                    {!editingDesc && (
                      <button
                        type="button"
                        onClick={() => {
                          setDescription(task.description || "");
                          setEditingDesc(true);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {tDetail("saveButton") === "Save" ? "Edit" : "ערוך"}
                      </button>
                    )}
                  </div>
                  {editingDesc ? (
                    <div className="space-y-2">
                      <Textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="min-h-[120px]"
                        dir={dir}
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleDescSave} disabled={saving} className="gap-1">
                          <Save className="h-3 w-3" />
                          {saving ? "..." : tDetail("saveButton")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm" dir={dir}>
                      {task.description ? (
                        <LinkifiedText>{task.description}</LinkifiedText>
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
                        // Cmd/Ctrl+Enter submits — common pattern in chat UIs.
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && newUpdate.trim()) {
                          e.preventDefault();
                          handleAddUpdate();
                        }
                      }}
                      placeholder={tDetail("addUpdatePlaceholder")}
                      className="min-h-[40px] text-sm resize-none flex-1"
                      dir={dir}
                      rows={1}
                    />
                    <Button
                      size="sm"
                      onClick={handleAddUpdate}
                      disabled={addingUpdate || !newUpdate.trim()}
                      className="shrink-0 self-start"
                      title="Cmd/Ctrl+Enter"
                    >
                      <Save className="h-3 w-3" />
                    </Button>
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

              <Separator />

              {/* AI Actions — functional */}
              {task.ai_actions && task.ai_actions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {task.ai_actions.map((action, i) => (
                    <Button
                      key={i}
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      onClick={() => onQuickAction?.(task.id, action)}
                    >
                      <Zap className="h-3 w-3" />
                      {translateActionLabel(action.label, tActions)}
                    </Button>
                  ))}
                </div>
              )}

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

          {/* Sticky bottom actions */}
          <div className="border-t bg-background px-4 py-3 flex items-center justify-between pb-[max(12px,env(safe-area-inset-bottom))]">
            <div className="flex gap-1">
              <IconButton
                label={t("actions.aiChat")}
                color="blue"
                onClick={() => window.open(
                  `https://claude.ai/new?q=${encodeURIComponent(task.description || title)}`,
                  "_blank"
                )}
              >
                <MessageCircle />
              </IconButton>
              <IconButton
                label={t("actions.searchDocs")}
                color="green"
                onClick={() => onDriveSearch?.(task.id, task.description || title)}
                disabled={!onDriveSearch}
              >
                <FolderSearch />
              </IconButton>
              <IconButton label={t("actions.snooze")} color="amber" onClick={handleSnooze}>
                <Clock />
              </IconButton>
              {onDelete && (
                <IconButton
                  label={t("actions.delete")}
                  color="red"
                  onClick={() => onDelete(task.id)}
                >
                  <Trash2 />
                </IconButton>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 border-status-ok/40 text-status-ok/60 hover:bg-status-ok hover:text-white hover:border-status-ok active:bg-status-ok/90"
              onClick={handleComplete}
            >
              <CheckCircle2 className="h-4 w-4" />
              {t("actions.complete")}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      <SnoozeDialog
        open={snoozeOpen}
        onClose={() => setSnoozeOpen(false)}
        onConfirm={handleSnoozeConfirm}
      />

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
