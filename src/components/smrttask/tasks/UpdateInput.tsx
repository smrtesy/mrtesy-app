"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Search, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface UpdateInputProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}

type Intent =
  | "create_task"
  | "update_task"
  | "add_subtask"
  | "add_update"
  | "complete_task"
  | "dismiss_task"
  | "save_info"
  | "unknown";

interface DecisionPayload {
  title_he?: string;
  description?: string;
  due_date?: string | null;
  priority?: "urgent" | "high" | "medium" | "low";
  recurrence_rule?: string | null;
  checklist?: string[];
  subtasks?: string[];
  update_text?: string;
  body?: string;
  new_project_name?: string;
  new_subproject_name?: string;
  notes_for_user?: string;
  project_id?: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
  name_he: string | null;
  parent_id: string | null;
}

interface Decision {
  id: string;
  serial_display: string | null;
  intent: Intent;
  target_task_id: string | null;
  payload: DecisionPayload;
  reasoning: string | null;
}

interface TargetTask {
  id: string;
  serial_display: string | null;
  title: string | null;
  title_he: string | null;
  status: string;
  due_date: string | null;
  priority: string | null;
}

type OpenTaskOption = TargetTask;

const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

export function UpdateInput({ open, onClose, onApplied }: UpdateInputProps) {
  const t = useTranslations("router");
  const tTasks = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [targetTask, setTargetTask] = useState<TargetTask | null>(null);
  const [overrideIntent, setOverrideIntent] = useState<Intent | null>(null);
  const [editPayload, setEditPayload] = useState<DecisionPayload>({});
  const [pickingTarget, setPickingTarget] = useState(false);
  const [taskOptions, setTaskOptions] = useState<OpenTaskOption[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);

  const intent: Intent = overrideIntent ?? decision?.intent ?? "unknown";

  function reset() {
    setInput("");
    setDecision(null);
    setTargetTask(null);
    setOverrideIntent(null);
    setEditPayload({});
    setPickingTarget(false);
    setTaskOptions([]);
    setTaskSearch("");
    setCreatingProject(false);
  }

  async function loadProjects() {
    if (projects.length > 0) return;
    try {
      const { projects: rows } = await api<{ projects: ProjectOption[] }>("/api/projects");
      setProjects(rows ?? []);
    } catch {
      // selector just stays empty
    }
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleDecide() {
    if (!input.trim()) return;
    setLoading(true);
    try {
      const { decision: d, target_task } = await api<{ decision: Decision; target_task: TargetTask | null }>(
        "/api/router/decide",
        { method: "POST", body: { input } },
      );
      setDecision(d);
      setTargetTask(target_task);
      setEditPayload(d.payload || {});
      loadProjects();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadTaskOptions() {
    if (taskOptions.length > 0) return;
    try {
      const { tasks } = await api<{ tasks: OpenTaskOption[] }>(
        "/api/tasks?status=inbox,in_progress,snoozed&limit=200",
      );
      setTaskOptions(tasks ?? []);
    } catch {
      // selector just stays empty
    }
  }

  async function handleApply() {
    if (!decision) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        intent,
        payload: editPayload,
      };
      if (targetTask) body.target_task_id = targetTask.id;
      await api<{ ok: boolean }>(`/api/router/decisions/${decision.id}/apply`, {
        method: "POST",
        body,
      });
      toast.success(t("applied"));
      reset();
      onApplied();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDismiss() {
    if (!decision) return;
    try {
      await api(`/api/router/decisions/${decision.id}/dismiss`, { method: "POST" });
    } catch {
      // silent — the user is closing either way
    }
    handleClose();
  }

  const needsTarget =
    intent === "update_task" ||
    intent === "add_subtask" ||
    intent === "add_update" ||
    intent === "complete_task" ||
    intent === "dismiss_task";


  const taskOptionLabel = (task: OpenTaskOption) =>
    task.title_he || task.title || "(untitled)";

  // Flatten projects into a parent→child ordered list for the <select>, with
  // sub-projects indented under their parent. Any project (parent or sub) is
  // selectable, since a task can belong to either level.
  const projectName = (p: ProjectOption) =>
    locale === "he" && p.name_he ? p.name_he : p.name;
  const orderedProjects = (() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const roots = projects.filter((p) => !p.parent_id || !byId.has(p.parent_id));
    const out: { id: string; label: string }[] = [];
    for (const root of roots) {
      out.push({ id: root.id, label: projectName(root) });
      for (const child of projects.filter((p) => p.parent_id === root.id)) {
        out.push({ id: child.id, label: `  ↳ ${projectName(child)}` });
      }
    }
    return out;
  })();

  const filteredOptions = taskOptions.filter((task) => {
    const q = taskSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = [task.title, task.title_he, task.serial_display]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent side="bottom" className="h-auto max-h-[90vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start">{t("title")}</SheetTitle>
          <SheetDescription className="text-start">{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 py-4 overflow-y-auto">
          {!decision ? (
            <>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDecide();
                }}
                placeholder={t("placeholder")}
                className="min-h-[120px]"
                dir="auto"
                autoFocus
              />
              <Button
                onClick={handleDecide}
                disabled={loading || !input.trim()}
                className="w-full min-h-[48px]"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("classify")}
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              {/* Intent header */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="default">{t(`intents.${intent}`)}</Badge>
                {decision.serial_display && (
                  <Badge variant="outline" className="text-[10px]">
                    {decision.serial_display}
                  </Badge>
                )}
                {decision.reasoning && (
                  <span className="text-xs text-muted-foreground" dir="auto">
                    {decision.reasoning}
                  </span>
                )}
              </div>

              {/* Target task picker for non-create intents */}
              {needsTarget && (
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("targetTask")}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        setPickingTarget(!pickingTarget);
                        if (!pickingTarget) loadTaskOptions();
                      }}
                    >
                      <Search className="h-3 w-3" />
                      {pickingTarget ? tCommon("cancel") : t("notThisOne")}
                    </Button>
                  </div>
                  {targetTask ? (
                    <div className="flex items-center gap-2">
                      {targetTask.serial_display && (
                        <Badge variant="outline" className="text-[10px]">
                          {targetTask.serial_display}
                        </Badge>
                      )}
                      <span className="text-sm" dir="auto">
                        {taskOptionLabel(targetTask)}
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-status-warn">{t("targetMissing")}</p>
                  )}

                  {pickingTarget && (
                    <div className="space-y-2 pt-2 border-t">
                      <Input
                        value={taskSearch}
                        onChange={(e) => setTaskSearch(e.target.value)}
                        placeholder={t("searchTasks")}
                        dir="auto"
                      />
                      <div className="max-h-64 overflow-y-auto space-y-1">
                        {filteredOptions.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => {
                              setTargetTask(task);
                              setPickingTarget(false);
                            }}
                            className="w-full text-start flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                            dir="auto"
                          >
                            {task.serial_display && (
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {task.serial_display}
                              </Badge>
                            )}
                            <span className="truncate">{taskOptionLabel(task)}</span>
                          </button>
                        ))}
                        {filteredOptions.length === 0 && (
                          <p className="text-xs text-muted-foreground p-2">
                            {t("noTasks")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Editable payload — per intent */}
              {(intent === "create_task" || intent === "update_task") && (
                <div className="space-y-2 rounded-lg border p-3">
                  <div>
                    <label className="text-xs font-medium">{t("fields.title")}</label>
                    <Input
                      value={editPayload.title_he ?? ""}
                      onChange={(e) => setEditPayload({ ...editPayload, title_he: e.target.value })}
                      dir="auto"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t("fields.description")}</label>
                    <Textarea
                      value={editPayload.description ?? ""}
                      onChange={(e) => setEditPayload({ ...editPayload, description: e.target.value })}
                      dir="auto"
                      className="min-h-[60px]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium">{t("fields.dueDate")}</label>
                      <Input
                        type="date"
                        value={editPayload.due_date ?? ""}
                        onChange={(e) => setEditPayload({ ...editPayload, due_date: e.target.value || null })}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium">{t("fields.priority")}</label>
                      <select
                        value={editPayload.priority ?? "medium"}
                        onChange={(e) =>
                          setEditPayload({
                            ...editPayload,
                            priority: e.target.value as DecisionPayload["priority"],
                          })
                        }
                        className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                      >
                        {PRIORITY_VALUES.map((p) => (
                          <option key={p} value={p}>
                            {tTasks(`priority.${p}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t("fields.project")}</label>
                    <select
                      value={editPayload.project_id ?? ""}
                      onChange={(e) =>
                        setEditPayload({ ...editPayload, project_id: e.target.value || null })
                      }
                      className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                      dir="auto"
                    >
                      <option value="">{t("fields.noProject")}</option>
                      {orderedProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {Array.isArray(editPayload.checklist) && editPayload.checklist.length > 0 && (
                    <div>
                      <label className="text-xs font-medium">{t("fields.checklist")}</label>
                      <ul className="text-sm space-y-1 mt-1">
                        {editPayload.checklist.map((item, i) => (
                          <li key={i} className="flex items-start gap-2" dir="auto">
                            <span className="text-muted-foreground">☐</span>
                            <span className="flex-1">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {intent === "add_subtask" && Array.isArray(editPayload.subtasks) && (
                <div className="rounded-lg border p-3 space-y-1">
                  <label className="text-xs font-medium">{t("fields.subtasks")}</label>
                  <ul className="text-sm space-y-1 mt-1">
                    {editPayload.subtasks.map((item, i) => (
                      <li key={i} className="flex items-start gap-2" dir="auto">
                        <span className="text-muted-foreground">＋</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {intent === "add_update" && (
                <div className="rounded-lg border p-3 space-y-1">
                  <label className="text-xs font-medium">{t("fields.updateText")}</label>
                  <Textarea
                    value={editPayload.update_text ?? ""}
                    onChange={(e) => setEditPayload({ ...editPayload, update_text: e.target.value })}
                    dir="auto"
                    className="min-h-[80px]"
                  />
                </div>
              )}

              {intent === "save_info" && (
                <div className="space-y-2 rounded-lg border p-3">
                  <div>
                    <label className="text-xs font-medium">{t("fields.infoTitle")}</label>
                    <Input
                      value={editPayload.title_he ?? ""}
                      onChange={(e) => setEditPayload({ ...editPayload, title_he: e.target.value })}
                      dir="auto"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t("fields.infoBody")}</label>
                    <Textarea
                      value={editPayload.body ?? ""}
                      onChange={(e) => setEditPayload({ ...editPayload, body: e.target.value })}
                      dir="auto"
                      className="min-h-[80px]"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium">{t("fields.project")}</label>
                    {!creatingProject ? (
                      <select
                        value={editPayload.project_id ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "__new__") {
                            setCreatingProject(true);
                            setEditPayload({ ...editPayload, project_id: null, new_project_name: "", new_subproject_name: "" });
                          } else {
                            setEditPayload({ ...editPayload, project_id: val || null, new_project_name: undefined, new_subproject_name: undefined });
                          }
                        }}
                        className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                        dir="auto"
                      >
                        <option value="">{t("fields.noProject")}</option>
                        {orderedProjects.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                        <option value="__new__">{t("fields.createNewProject")}</option>
                      </select>
                    ) : (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center gap-2">
                          <Input
                            value={editPayload.new_project_name ?? ""}
                            onChange={(e) => setEditPayload({ ...editPayload, new_project_name: e.target.value })}
                            placeholder={t("fields.newProjectName")}
                            dir="auto"
                            className="flex-1"
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="shrink-0"
                            onClick={() => {
                              setCreatingProject(false);
                              setEditPayload({ ...editPayload, new_project_name: undefined, new_subproject_name: undefined, project_id: null });
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        <Input
                          value={editPayload.new_subproject_name ?? ""}
                          onChange={(e) => setEditPayload({ ...editPayload, new_subproject_name: e.target.value })}
                          placeholder={t("fields.newSubprojectName")}
                          dir="auto"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {intent === "unknown" && (
                <div className="rounded-lg border p-3 space-y-2 bg-status-warn-bg">
                  <p className="text-sm" dir="auto">
                    {editPayload.notes_for_user || t("unknownFallback")}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOverrideIntent("create_task");
                      setEditPayload({
                        title_he: input,
                        description: "",
                        due_date: null,
                        priority: "medium",
                      });
                    }}
                  >
                    {t("createAsNewTask")}
                  </Button>
                </div>
              )}

              {/* Action row */}
              <div className="flex gap-2 sticky bottom-0 bg-background pt-3 border-t">
                <Button
                  variant="outline"
                  onClick={handleDismiss}
                  className="min-h-[48px] gap-1"
                >
                  <X className="h-4 w-4" />
                  {tCommon("cancel")}
                </Button>
                <Button
                  onClick={handleApply}
                  disabled={
                    loading ||
                    intent === "unknown" ||
                    (needsTarget && !targetTask)
                  }
                  className="flex-1 min-h-[48px] gap-1"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {t("apply")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
