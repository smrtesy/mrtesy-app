"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { AITrail } from "@/components/smrttask/common/AITrail";
import { TaskChecklist } from "@/components/smrttask/tasks/TaskChecklist";
import { TaskMaterials } from "@/components/smrttask/tasks/TaskMaterials";
import type { Task } from "@/types/task";

interface ProjectOption {
  id: string;
  name: string;
  name_he: string | null;
  color: string | null;
}

interface TaskDetailProps {
  task: Task | null;
  locale: string;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
  onDelete?: (taskId: string) => void;
  onQuickAction?: (taskId: string, action: { label: string; prompt: string }) => void;
  onDriveSearch?: (taskId: string, description: string) => void;
}

export function TaskDetail({ task, locale, open, onClose, onUpdate, onDelete, onQuickAction, onDriveSearch }: TaskDetailProps) {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const tDetail = useTranslations("taskDetailExt");
  const tActions = useTranslations("tasks.actions");

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
  const [showUpdates, setShowUpdates] = useState(false);
  const [newUpdate, setNewUpdate] = useState("");
  const [addingUpdate, setAddingUpdate] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  if (!task) return null;

  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const updates = (task.updates || []).slice(-20).reverse();
  const generated = task.ai_generated_content || [];
  const docs = task.linked_drive_docs || [];

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
      } catch { /* ignore — selector just stays empty */ }
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

  async function handleSnooze() {
    if (!task) return;
    try {
      await api(`/api/tasks/${task.id}/snooze`, { method: "POST" });
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
      await api(`/api/tasks/${task.id}/updates`, {
        method: "POST",
        body: { content: newUpdate.trim(), type: "note" },
      });
      toast.success(tDetail("toastUpdateAdded"));
      setNewUpdate("");
      onUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setAddingUpdate(false);
    }
  }

  // Radix Dialog portals don't always inherit the html dir attribute, so we
  // pin it explicitly on the SheetContent — without this the inner flex rows
  // (badges, checklist controls, sticky footer buttons) render LTR even when
  // the rest of the page is RTL.
  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        dir={dir}
        className="w-full sm:max-w-[480px] p-0 flex flex-col max-md:!w-full max-md:!max-w-full max-md:!inset-0 max-md:!top-[10vh]"
      >
        <SheetHeader className="sticky top-0 z-10 bg-background border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-start text-base flex-1" dir="auto">{title}</SheetTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={startFieldEdit}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
          {/* Serial + source + linked project — all sourced from the joined data */}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <SerialBadge serial={task.serial_display} />
            <SourceLink source={task.source_messages} />
            {task.projects && (() => {
              const proj = task.projects!;
              const projName = locale === "he" && proj.name_he ? proj.name_he : proj.name;
              return (
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                  style={proj.color ? { borderColor: proj.color, color: proj.color } : undefined}
                >
                  <Folder className="h-3 w-3" />
                  {projName}
                </span>
              );
            })()}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-4">
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
                  <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} dir="auto" />
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
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium">{tDetail("dueDateLabel")}</label>
                  <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium">{tDetail("projectLabel")}</label>
                  <select
                    value={editProjectId}
                    onChange={(e) => setEditProjectId(e.target.value)}
                    className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                  >
                    <option value="">{tDetail("noProjectOption")}</option>
                    {selectorProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {locale === "he" && p.name_he ? p.name_he : p.name}
                      </option>
                    ))}
                  </select>
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

            {/* Description */}
            <div>
              <h4 className="text-sm font-medium mb-2">{t("detail.description")}</h4>
              {editingDesc ? (
                <div className="space-y-2">
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="min-h-[120px]"
                    dir="auto"
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
                <div
                  className="cursor-pointer rounded border p-3 text-sm hover:bg-accent/50 min-h-[60px]"
                  dir="auto"
                  onClick={() => {
                    setDescription(task.description || "");
                    setEditingDesc(true);
                  }}
                >
                  {task.description || (
                    <span className="text-muted-foreground">{t("detail.editDescription")}</span>
                  )}
                </div>
              )}
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

            {/* Updates History */}
            <div>
              <button
                onClick={() => setShowUpdates(!showUpdates)}
                className="flex w-full items-center justify-between py-2 text-sm font-medium"
              >
                {t("detail.updates")} ({updates.length})
                {showUpdates ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showUpdates && (
                <div className="space-y-2 mt-1">
                  {/* Add new update */}
                  <div className="flex gap-2">
                    <Textarea
                      value={newUpdate}
                      onChange={(e) => setNewUpdate(e.target.value)}
                      placeholder={tDetail("addUpdatePlaceholder")}
                      className="min-h-[60px] text-xs"
                      dir="auto"
                    />
                    <Button
                      size="sm"
                      onClick={handleAddUpdate}
                      disabled={addingUpdate || !newUpdate.trim()}
                      className="shrink-0 h-auto"
                    >
                      <Save className="h-3 w-3" />
                    </Button>
                  </div>
                  {updates.map((update, i) => (
                    <div
                      key={update.id}
                      className={cn(
                        "rounded border p-2 text-xs",
                        i === 0 && "border-blue-200 bg-blue-50"
                      )}
                    >
                      <div className="flex justify-between text-muted-foreground mb-1">
                        <Badge variant="outline" className="text-[10px]">{update.type}</Badge>
                        <span>{new Date(update.created_at).toLocaleString()}</span>
                      </div>
                      <p dir="auto">{update.content}</p>
                    </div>
                  ))}
                  {updates.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("detail.noUpdates")}</p>
                  )}
                </div>
              )}
            </div>

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
                        {item.result && <p className="whitespace-pre-wrap" dir="auto">{item.result}</p>}
                        {item.draft_url && (
                          <a
                            href={item.draft_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline"
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
                        <FolderSearch className="h-4 w-4 text-blue-500" />
                        <span className="flex-1 truncate" dir="auto">{doc.name}</span>
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
        </ScrollArea>

        {/* Sticky bottom actions */}
        <div className="sticky bottom-0 border-t bg-background px-4 py-3 flex items-center justify-between pb-[max(12px,env(safe-area-inset-bottom))]">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10"
              onClick={() => window.open(
                `https://claude.ai/new?q=${encodeURIComponent(task.description || title)}`,
                "_blank"
              )}
              title={t("actions.aiChat")}
            >
              <MessageCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10"
              onClick={() => onDriveSearch?.(task.id, task.description || title)}
              disabled={!onDriveSearch}
              title={t("actions.searchDocs")}
            >
              <FolderSearch className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-10 w-10" onClick={handleSnooze} title={t("actions.snooze")}>
              <Clock className="h-4 w-4" />
            </Button>
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={() => onDelete(task.id)}
                title={t("actions.delete")}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 border-green-600/40 text-green-600/60 hover:bg-green-600 hover:text-white hover:border-green-600 active:bg-green-700"
            onClick={handleComplete}
          >
            <CheckCircle2 className="h-4 w-4" />
            {t("actions.complete")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
