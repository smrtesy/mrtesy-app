"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Check, Plus, X, Zap, Home, ChevronDown, ChevronUp, Paperclip } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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

// Recurrence kinds offered in the UI. They map to the compact recurrence_rule
// the backend understands (see server/.../recurrence.ts).
type RecurrenceKind = "none" | "daily" | "weekly" | "weekdays" | "monthly" | "yearly" | "hebrew";

// Sunday-first, matching JS getDay() (0=Sun .. 6=Sat) and the BYDAY codes.
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function buildRecurrenceRule(kind: RecurrenceKind, weekdays: number[]): string | null {
  switch (kind) {
    case "none":     return null;
    case "daily":    return "FREQ=DAILY";
    case "weekly":   return "FREQ=WEEKLY";
    case "weekdays": return weekdays.length ? `FREQ=WEEKLY;BYDAY=${weekdays.slice().sort().map((d) => WEEKDAY_CODES[d]).join(",")}` : null;
    case "monthly":  return "FREQ=MONTHLY";
    case "yearly":   return "FREQ=YEARLY";
    case "hebrew":   return "FREQ=HEBREW_YEARLY";
  }
}

const LAST_INFO_PROJECT_KEY = "smrtesy:lastInfoProject";

/**
 * The "new" dialog — two tabs:
 *   task (default): fast capture. Title + Enter is enough; the task lands on
 *     the desk as ⚡quick unless toggled. No project picker — projects belong
 *     to the info world.
 *   info: a knowledge piece for a project's info board (title optional).
 */
export function ManualTaskInput({ open, onClose, onCreated }: ManualTaskInputProps) {
  const t = useTranslations("manualTask");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [tab, setTab] = useState<"task" | "info">("task");

  // ── task tab state ──────────────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [size, setSize] = useState<"quick" | "regular">("quick");
  const [isHome, setIsHome] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceKind>("none");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

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
    setRecurrence("none");
    setWeekdays([]);
    setMoreOpen(false);
    setDescription("");
    setInfoTitle("");
    setInfoBody("");
    setProjectId("");
    setSubProjectId("");
    setNewProjectName("");
    setInfoFile(null);
    setLoading(false);
  }, []);

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
    reset();
    onClose();
  }

  const projectName = (p: ProjectOption) =>
    locale === "he" && p.name_he ? p.name_he : p.name;

  const byId = new Map(projects.map((p) => [p.id, p]));
  const rootProjects = projects.filter((p) => !p.parent_id || !byId.has(p.parent_id));
  const subProjects = projectId ? projects.filter((p) => p.parent_id === projectId) : [];

  function toggleWeekday(day: number) {
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  function handleRecurrenceChange(kind: RecurrenceKind) {
    setRecurrence(kind);
    if (kind === "weekdays" && weekdays.length === 0 && dueDate) {
      setWeekdays([new Date(`${dueDate}T00:00:00`).getDay()]);
    }
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
    if (recurrence !== "none" && !dueDate) {
      toast.error(t("recurrenceNeedsDate"));
      return;
    }
    if (recurrence === "weekdays" && weekdays.length === 0) {
      toast.error(t("recurrenceNeedsWeekday"));
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
      if (description.trim()) body.description = description.trim();
      if (dueDate) body.due_date = dueDate;
      if (dueTime) body.due_time = dueTime;
      const recurrenceRule = buildRecurrenceRule(recurrence, weekdays);
      if (recurrenceRule) body.recurrence_rule = recurrenceRule;
      // A manual task goes straight onto the desk (pinned), per the desk model.
      // Position = seconds since a fixed recent epoch: monotonic (new tasks
      // append after older pins) and safely inside int4.
      body.today_position = Math.floor(Date.now() / 1000) - 1_700_000_000;

      await api<{ task: unknown }>("/api/tasks", { method: "POST", body });
      toast.success(t("created"));
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
    const body = infoBody.trim();
    if (!body && !infoTitle.trim()) {
      toast.error(t("info.bodyRequired"));
      return;
    }
    setLoading(true);
    try {
      const { item } = await api<{ item: { id: string } }>(`/api/projects/${targetId}/info-items`, {
        method: "POST",
        body: { title: infoTitle.trim() || body.slice(0, 80), body },
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
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent side="bottom" className="h-auto max-h-[90vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start">{t("title")}</SheetTitle>
          <SheetDescription className="text-start">{t("description")}</SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "task" | "info")} dir={locale === "he" ? "rtl" : "ltr"}>
          <TabsList className="w-full">
            <TabsTrigger value="task" className="flex-1">{t("tabTask")}</TabsTrigger>
            <TabsTrigger value="info" className="flex-1">{t("tabInfo")}</TabsTrigger>
          </TabsList>

          {/* ── TASK ─────────────────────────────────────────────────── */}
          <TabsContent value="task" className="mt-3 space-y-4 overflow-y-auto">
            <div className="flex gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim() && !loading) handleCreateTask();
                }}
                placeholder={t("titlePlaceholder")}
                dir="auto"
                autoFocus
                className="flex-1"
              />
              <Button onClick={handleCreateTask} disabled={loading || !title.trim()} className="gap-1 shrink-0">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t("create")}
              </Button>
            </div>

            {/* Size + context toggles */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-lg border p-0.5">
                <button
                  type="button"
                  onClick={() => setSize("quick")}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
                  "flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  isHome ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
                )}
                aria-pressed={isHome}
              >
                <Home className="h-3.5 w-3.5" />
                {t("contextHome")}
              </button>
            </div>

            {/* Due date + time + recurrence */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium">{t("dueDateLabel")}</label>
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} dir="ltr" />
              </div>
              <div>
                <label className="text-xs font-medium">{t("dueTimeLabel")}</label>
                <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} dir="ltr" />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="text-xs font-medium">{t("recurrenceLabel")}</label>
                <select
                  value={recurrence}
                  onChange={(e) => handleRecurrenceChange(e.target.value as RecurrenceKind)}
                  className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                  dir="auto"
                >
                  <option value="none">{t("recurrenceNone")}</option>
                  <option value="daily">{t("recurrenceDaily")}</option>
                  <option value="weekly">{t("recurrenceWeekly")}</option>
                  <option value="weekdays">{t("recurrenceWeekdays")}</option>
                  <option value="monthly">{t("recurrenceMonthly")}</option>
                  <option value="yearly">{t("recurrenceYearly")}</option>
                  <option value="hebrew">{t("recurrenceHebrew")}</option>
                </select>
              </div>
            </div>

            {recurrence === "weekdays" && (
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_CODES.map((_, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    className={`h-9 w-9 rounded-full border text-sm transition-colors ${
                      weekdays.includes(day)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground"
                    }`}
                    aria-pressed={weekdays.includes(day)}
                  >
                    {t(`weekdayShort.${day}`)}
                  </button>
                ))}
              </div>
            )}
            {recurrence === "hebrew" && (
              <p className="text-[11px] text-muted-foreground" dir="auto">{t("recurrenceHebrewHint")}</p>
            )}

            {/* More: description */}
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setMoreOpen((v) => !v)}
            >
              {moreOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {t("moreOptions")}
            </button>
            {moreOpen && (
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                dir="auto"
                className="min-h-[80px]"
              />
            )}
          </TabsContent>

          {/* ── INFO ─────────────────────────────────────────────────── */}
          <TabsContent value="info" className="mt-3 space-y-4 overflow-y-auto">
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
              <Button variant="outline" onClick={handleClose} className="gap-1">
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
      </SheetContent>
    </Sheet>
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
