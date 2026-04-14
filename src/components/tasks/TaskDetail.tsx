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
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

interface TaskDetailProps {
  task: Task | null;
  locale: string;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
  onQuickAction?: (taskId: string, action: { label: string; prompt: string }) => void;
}

export function TaskDetail({ task, locale, open, onClose, onUpdate, onQuickAction }: TaskDetailProps) {
  const t = useTranslations("tasks");
  const supabase = createClient();

  // Description edit
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState("");

  // Task field edit
  const [editingFields, setEditingFields] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editStatus, setEditStatus] = useState("");

  const [saving, setSaving] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  if (!task) return null;

  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const updates = (task.updates || []).slice(-20).reverse();
  const generated = task.ai_generated_content || [];
  const docs = task.linked_drive_docs || [];

  function startFieldEdit() {
    if (!task) return;
    setEditTitle(locale === "he" ? task.title_he || task.title : task.title);
    setEditPriority(task.priority);
    setEditDueDate(task.due_date || "");
    setEditStatus(task.status);
    setEditingFields(true);
  }

  async function saveFieldEdit() {
    if (!task) return;
    setSaving(true);
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (locale === "he") {
      updateData.title_he = editTitle;
    } else {
      updateData.title = editTitle;
    }
    updateData.priority = editPriority;
    updateData.status = editStatus;
    updateData.due_date = editDueDate || null;

    if (editStatus !== task.status) {
      updateData.status_changed_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from("tasks")
      .update(updateData)
      .eq("id", task.id);

    setSaving(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(t("common.save") || "Saved");
      setEditingFields(false);
      onUpdate();
    }
  }

  async function handleDescSave() {
    if (!task) return;
    setSaving(true);
    const { error } = await supabase
      .from("tasks")
      .update({
        description,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id);

    setSaving(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(t("detail.description"));
      setEditingDesc(false);
      onUpdate();
    }
  }

  async function handleComplete() {
    if (!task) return;
    const { error } = await supabase
      .from("tasks")
      .update({
        status: "archived",
        completed_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", task.id);
    if (error) { toast.error(error.message); return; }
    toast.success(t("actions.complete"));
    onClose();
    onUpdate();
  }

  async function handleSnooze() {
    if (!task) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const { error } = await supabase
      .from("tasks")
      .update({
        snoozed_until: tomorrow.toISOString(),
        snooze_count: (task.snooze_count || 0) + 1,
        status: "snoozed",
      })
      .eq("id", task.id);
    if (error) { toast.error(error.message); return; }
    toast.success(t("actions.snooze"));
    onClose();
    onUpdate();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] p-0 flex flex-col max-md:!w-full max-md:!max-w-full max-md:!inset-0 max-md:!top-[10vh]"
      >
        <SheetHeader className="sticky top-0 z-10 bg-background border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-start text-base flex-1">{title}</SheetTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={startFieldEdit}>
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-4">
          <div className="space-y-4">
            {/* Field Editing */}
            {editingFields && (
              <div className="space-y-3 rounded-lg border p-3 bg-muted/50">
                <div>
                  <label className="text-xs font-medium">{locale === "he" ? "כותרת" : "Title"}</label>
                  <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} dir="auto" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium">{t("priority.medium").replace(/.*/, "Priority")}</label>
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
                    <label className="text-xs font-medium">Status</label>
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
                  <label className="text-xs font-medium">Due Date</label>
                  <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveFieldEdit} disabled={saving} className="gap-1">
                    <Save className="h-3 w-3" />
                    {saving ? "..." : (locale === "he" ? "שמור" : "Save")}
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
                      {saving ? "..." : (locale === "he" ? "שמור" : "Save")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className="cursor-pointer rounded border p-3 text-sm hover:bg-accent/50 min-h-[60px]"
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
                    {action.label}
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
                      <p>{update.content}</p>
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
                          <Badge variant="outline" className="text-[10px]">{item.action_label}</Badge>
                          <span className="text-muted-foreground">
                            {new Date(item.created_at).toLocaleString()}
                          </span>
                        </div>
                        {item.result && <p className="whitespace-pre-wrap">{item.result}</p>}
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
                        <span className="flex-1 truncate">{doc.name}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
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
              title={t("actions.searchDocs")}
            >
              <FolderSearch className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-10 w-10" onClick={handleSnooze} title={t("actions.snooze")}>
              <Clock className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="default"
            size="sm"
            className="gap-1 bg-green-600 hover:bg-green-700"
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
