"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Check, Plus, X, Zap, Home, AlignLeft, ListChecks, Paperclip, CalendarDays, Clock } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { dueUrgency } from "@/lib/workdays";
import { RecurrenceEditor, type RecurrenceModel } from "./RecurrenceEditor";

interface ManualTaskInputProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface ProjectOption {
  id: string;
  name: string;
  name_he: string | null;
  parent_id: string | null;
}

interface DraftSubtask {
  id: string;
  title: string;
}

const LAST_INFO_PROJECT_KEY = "smrtesy:lastInfoProject";
const DRAFT_KEY = "smrtesy:manualTaskDraft";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `st-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * The "new" dialog — a centered modal with two tabs:
 *   task (default): fast capture. Title + Enter is enough; the task lands on
 *     the desk as ⚡quick "on the desk" unless toggled. Description and subtasks
 *     are opt-in (revealed by their own buttons). The whole task draft
 *     auto-saves to localStorage so a stray close never loses typed text.
 *   info: a knowledge piece for a project's info board (title optional).
 */
export function ManualTaskInput({ open, onClose, onCreated }: ManualTaskInputProps) {
  const t = useTranslations("manualTask");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const blocked = useWorkCalendar();
  const dir = locale === "he" ? "rtl" : "ltr";

  const [tab, setTab] = useState<"task" | "info">("task");

  // ── task tab state ──────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [size, setSize] = useState<"quick" | "regular">("quick");
  const [isHome, setIsHome] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceModel>({ rule: null, until: null });
  const [recurResetKey, setRecurResetKey] = useState(0);
  const [showDescription, setShowDescription] = useState(false);
  const [description, setDescription] = useState("");
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [subtasks, setSubtasks] = useState<DraftSubtask[]>([]);
  const [loading, setLoading] = useState(false);
  const hydrated = useRef(false);

  // ── info tab state ──────────────────────────────────────────────────────
  const [infoTitle, setInfoTitle] = useState("");
  const [infoBody, setInfoBody] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [subProjectId, setSubProjectId] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [infoFile, setInfoFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setTab("task");
    setTitle("");
    setSize("quick");
    setIsHome(false);
    setDueDate("");
    setDueTime("");
    setRecurrence({ rule: null, until: null });
    setRecurResetKey((k) => k + 1);
    setShowDescription(false);
    setDescription("");
    setShowSubtasks(false);
    setSubtasks([]);
    setInfoTitle("");
    setInfoBody("");
    setProjectId("");
    setSubProjectId("");
    setNewProjectName("");
    setInfoFile(null);
    setLoading(false);
    try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }, []);

  // Hydrate the task draft once each time the dialog opens.
  useEffect(() => {
    if (!open) { hydrated.current = false; return; }
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<{
          title: string; showDescription: boolean; description: string;
          showSubtasks: boolean; subtasks: DraftSubtask[];
          size: "quick" | "regular"; isHome: boolean; dueDate: string; dueTime: string;
        }>;
        setTitle(d.title ?? "");
        setShowDescription(!!d.showDescription);
        setDescription(d.description ?? "");
        setShowSubtasks(!!d.showSubtasks);
        setSubtasks(Array.isArray(d.subtasks) ? d.subtasks : []);
        setSize(d.size === "regular" ? "regular" : "quick");
        setIsHome(!!d.isHome);
        setDueDate(d.dueDate ?? "");
        setDueTime(d.dueTime ?? "");
      }
    } catch { /* ignore a corrupt draft */ }
    hydrated.current = true;
  }, [open]);

  // Auto-save the task draft as the user types (after hydration, while open).
  useEffect(() => {
    if (!open || !hydrated.current) return;
    const draft = { title, showDescription, description, showSubtasks, subtasks, size, isHome, dueDate, dueTime };
    try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore quota */ }
  }, [open, title, showDescription, description, showSubtasks, subtasks, size, isHome, dueDate, dueTime]);

  // Load projects when the info tab is first needed; remember the last target.
  useEffect(() => {
    if (!open || tab !== "info") return;
    let cancelled = false;
    (async () => {
      try {
        const { projects: rows } = await api<{ projects: ProjectOption[] }>("/api/projects");
        if (cancelled) return;
        setProjects(rows ?? []);
        if (!projectId) {
          const last = window.localStorage.getItem(LAST_INFO_PROJECT_KEY);
          if (last && (rows ?? []).some((p) => p.id === last)) {
            const lastProject = (rows ?? []).find((p) => p.id === last)!;
            if (lastProject.parent_id) {
              setProjectId(lastProject.parent_id);
              setSubProjectId(lastProject.id);
            } else {
              setProjectId(lastProject.id);
            }
          }
        }
      } catch {
        // selects stay empty
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  function handleClose() {
    // Note: we deliberately do NOT reset here — the draft survives a close so
    // the user can reopen and keep typing. reset() runs only after a successful
    // create (which clears the draft) or an explicit cancel on the info tab.
    onClose();
  }

  const projectName = (p: ProjectOption) =>
    locale === "he" && p.name_he ? p.name_he : p.name;

  const byId = new Map(projects.map((p) => [p.id, p]));
  const rootProjects = projects.filter((p) => !p.parent_id || !byId.has(p.parent_id));
  const subProjects = projectId ? projects.filter((p) => p.parent_id === projectId) : [];

  // ── subtasks ──────────────────────────────────────────────────────────────
  function addSubtask() {
    setShowSubtasks(true);
    setSubtasks((prev) => [...prev, { id: newId(), title: "" }]);
  }
  function updateSubtask(id: string, value: string) {
    setSubtasks((prev) => prev.map((s) => (s.id === id ? { ...s, title: value } : s)));
  }
  function removeSubtask(id: string) {
    setSubtasks((prev) => prev.filter((s) => s.id !== id));
  }

  // ── create: task ────────────────────────────────────────────────────────

  async function handleCreateTask() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t("titleRequired"));
      return;
    }
    if (dueTime && !dueDate) {
      toast.error(t("timeNeedsDate"));
      return;
    }
    if (recurrence.rule && !dueDate) {
      toast.error(t("recurrenceNeedsDate"));
      return;
    }
    if (recurrence.rule && recurrence.endNeedsDate) {
      toast.error(t("recurrenceNeedsEndDate"));
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        title: trimmedTitle,
        title_he: trimmedTitle,
        size,
      };
      if (isHome) body.context = "home";
      if (showDescription && description.trim()) body.description = description.trim();
      if (dueDate) body.due_date = dueDate;
      if (dueTime) body.due_time = dueTime;
      if (recurrence.rule) body.recurrence_rule = recurrence.rule;
      if (recurrence.until) body.recurrence_until = recurrence.until;
      const checklist = subtasks
        .filter((s) => s.title.trim())
        .map((s) => ({
          id: s.id,
          title: s.title.trim(),
          done: false,
          created_at: new Date().toISOString(),
          created_by: "user" as const,
        }));
      if (checklist.length) body.checklist = checklist;
      // A manual task goes straight onto the desk (pinned) — UNLESS it got a
      // far-off deadline, in which case it belongs in the waiting list and
      // the 3-day rule will promote it when the time comes. Position =
      // seconds since a fixed recent epoch: monotonic and safely inside int4.
      const goesToWaiting = !!dueDate && dueUrgency(dueDate, blocked) === "far";
      if (!goesToWaiting) {
        body.today_position = Math.floor(Date.now() / 1000) - 1_700_000_000;
      }

      await api<{ task: unknown }>("/api/tasks", { method: "POST", body });
      toast.success(goesToWaiting ? t("createdToWaiting", { date: dueDate }) : t("created"));
      reset();
      onCreated();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // ── create: info ────────────────────────────────────────────────────────

  async function handleCreateProjectInline() {
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const { project } = await api<{ project: ProjectOption }>("/api/projects", {
        method: "POST",
        body: projectId ? { name, name_he: name, parent_id: projectId } : { name, name_he: name },
      });
      setProjects((prev) => [...prev, project]);
      if (projectId) setSubProjectId(project.id);
      else setProjectId(project.id);
      setNewProjectName("");
      toast.success(t("info.projectCreated"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleCreateInfo() {
    const targetId = subProjectId || projectId;
    if (!targetId) {
      toast.error(t("info.projectRequired"));
      return;
    }
    const infoBodyTrimmed = infoBody.trim();
    if (!infoBodyTrimmed && !infoTitle.trim()) {
      toast.error(t("info.bodyRequired"));
      return;
    }
    setLoading(true);
    try {
      const { item } = await api<{ item: { id: string } }>(`/api/projects/${targetId}/info-items`, {
        method: "POST",
        body: { title: infoTitle.trim() || infoBodyTrimmed.slice(0, 80), body: infoBodyTrimmed },
      });
      if (infoFile && item?.id) {
        const data = await fileToBase64(infoFile);
        await api(`/api/projects/${targetId}/info-items/${item.id}/attachments`, {
          method: "POST",
          body: { filename: infoFile.name, mime: infoFile.type || undefined, data },
        }).catch((e) => toast.error(t("info.attachFailed", { error: (e as Error).message })));
      }
      window.localStorage.setItem(LAST_INFO_PROJECT_KEY, targetId);
      toast.success(t("info.saved"));
      reset();
      onCreated();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-5">
        {/* Visually-compact title; the tabs sit right under it. */}
        <DialogTitle className="text-start text-base">{t("title")}</DialogTitle>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "task" | "info")} dir={dir} className="mt-1">
          <TabsList className="h-8 w-auto self-start">
            <TabsTrigger value="task" className="px-3 py-1 text-xs">{t("tabTask")}</TabsTrigger>
            <TabsTrigger value="info" className="px-3 py-1 text-xs">{t("tabInfo")}</TabsTrigger>
          </TabsList>

          {/* ── TASK ─────────────────────────────────────────────────── */}
          <TabsContent value="task" className="mt-3 space-y-3">
            {/* Central title row */}
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                // Enter on the title → create immediately. With no due date the
                // task lands on the desk as a quick "on the desk" task.
                if (e.key === "Enter" && title.trim() && !loading) {
                  e.preventDefault();
                  handleCreateTask();
                }
              }}
              placeholder={t("titlePlaceholder")}
              dir={dir}
              autoFocus
              className="text-base"
            />

            {/* Add description / add subtask */}
            <div className="flex flex-wrap gap-2">
              {!showDescription && (
                <button
                  type="button"
                  onClick={() => setShowDescription(true)}
                  className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <AlignLeft className="h-3.5 w-3.5" />
                  {t("addDescription")}
                </button>
              )}
              <button
                type="button"
                onClick={addSubtask}
                className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ListChecks className="h-3.5 w-3.5" />
                {t("addSubtask")}
              </button>
            </div>

            {showDescription && (
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                dir="auto"
                className="min-h-[72px]"
                autoFocus
              />
            )}

            {showSubtasks && subtasks.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">{t("subtasksLabel")}</div>
                {subtasks.map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <Input
                      value={s.title}
                      onChange={(e) => updateSubtask(s.id, e.target.value)}
                      placeholder={t("subtaskPlaceholder")}
                      dir="auto"
                      className="h-8 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeSubtask(s.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={tCommon("delete")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addSubtask}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("addSubtask")}
                </button>
              </div>
            )}

            {/* One row: quick/regular · home · date · time */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border p-0.5">
                <button
                  type="button"
                  onClick={() => setSize("quick")}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
                    size === "quick" ? "bg-status-warn-bg text-status-warn" : "text-muted-foreground",
                  )}
                >
                  <Zap className="h-3.5 w-3.5" />
                  {t("sizeQuick")}
                </button>
                <button
                  type="button"
                  onClick={() => setSize("regular")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
                    size === "regular" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                  )}
                >
                  {t("sizeRegular")}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setIsHome((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded-lg border px-2.5 py-1 text-sm font-medium transition-colors",
                  isHome ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
                )}
                aria-pressed={isHome}
              >
                <Home className="h-3.5 w-3.5" />
                {t("contextHome")}
              </button>

              <div className="flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                <DatePicker value={dueDate} onChange={setDueDate} className="h-8" />
              </div>

              <div className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="time"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                  dir="ltr"
                  className="h-8 w-[7.5rem]"
                />
              </div>
            </div>

            {/* Recurrence — Google-Calendar style */}
            <RecurrenceEditor dueDate={dueDate} onChange={setRecurrence} resetKey={recurResetKey} />

            {/* Create — at the bottom of the window */}
            <Button onClick={handleCreateTask} disabled={loading || !title.trim()} className="w-full gap-1">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t("create")}
            </Button>
          </TabsContent>

          {/* ── INFO ─────────────────────────────────────────────────── */}
          <TabsContent value="info" className="mt-3 space-y-4">
            <Input
              value={infoTitle}
              onChange={(e) => setInfoTitle(e.target.value)}
              placeholder={t("info.titlePlaceholder")}
              dir="auto"
            />
            <Textarea
              value={infoBody}
              onChange={(e) => setInfoBody(e.target.value)}
              placeholder={t("info.bodyPlaceholder")}
              dir="auto"
              className="min-h-[120px]"
            />

            {/* File attach */}
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => setInfoFile(e.target.files?.[0] ?? null)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-3.5 w-3.5" />
                {t("info.attachFile")}
              </Button>
              {infoFile && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" dir="ltr">
                  {infoFile.name}
                  <button type="button" onClick={() => setInfoFile(null)} aria-label={tCommon("delete")}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>

            {/* Project + sub-project + inline create */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium">{t("projectLabel")}</label>
                <select
                  value={projectId}
                  onChange={(e) => { setProjectId(e.target.value); setSubProjectId(""); }}
                  className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                  dir="auto"
                >
                  <option value="">{t("noProject")}</option>
                  {rootProjects.map((p) => (
                    <option key={p.id} value={p.id}>{projectName(p)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium">{t("subProjectLabel")}</label>
                <select
                  value={subProjectId}
                  onChange={(e) => setSubProjectId(e.target.value)}
                  disabled={subProjects.length === 0}
                  className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
                  dir="auto"
                >
                  <option value="">{t("noSubProject")}</option>
                  {subProjects.map((p) => (
                    <option key={p.id} value={p.id}>{projectName(p)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder={projectId ? t("info.newSubProjectPlaceholder") : t("info.newProjectPlaceholder")}
                dir="auto"
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1 shrink-0"
                onClick={handleCreateProjectInline}
                disabled={creatingProject || !newProjectName.trim()}
              >
                {creatingProject ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {t("info.createProject")}
              </Button>
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" onClick={() => { reset(); onClose(); }} className="gap-1">
                <X className="h-4 w-4" />
                {tCommon("cancel")}
              </Button>
              <Button
                onClick={handleCreateInfo}
                disabled={loading || (!infoBody.trim() && !infoTitle.trim())}
                className="flex-1 gap-1"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("info.save")}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
