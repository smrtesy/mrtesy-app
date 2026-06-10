"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { StickyNote, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

const LAST_PROJECT_KEY = "smrtesy:lastInfoProject";

interface ProjectRow {
  id: string;
  name: string;
  name_he: string | null;
  parent_id: string | null;
}

function readLastProject(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(LAST_PROJECT_KEY) ?? "";
}

function writeLastProject(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LAST_PROJECT_KEY, id);
}

/**
 * Note-icon action that saves a suggestion/task's content into a project's
 * Information Center. Defaults to the item's own project (falling back to the
 * last project used); the user can switch to any project / sub-project, or
 * create a new project inline. Project list is fetched lazily on first open.
 */
export function SaveAsInfoButton({
  defaultProjectId,
  defaultTitle,
  defaultBody,
}: {
  defaultProjectId?: string | null;
  defaultTitle: string;
  defaultBody?: string | null;
}) {
  const t = useTranslations("projectDetail");
  const tBoard = useTranslations("infoBoard");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody ?? "");
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [targetId, setTargetId] = useState(defaultProjectId ?? "");
  const [saving, setSaving] = useState(false);

  // Inline project creation
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  function orderProjects(list: ProjectRow[]): ProjectRow[] {
    // parents first, each followed by its own sub-projects, for a readable list
    const parents = list.filter((p) => !p.parent_id);
    const ordered: ProjectRow[] = [];
    for (const parent of parents) {
      ordered.push(parent);
      ordered.push(...list.filter((c) => c.parent_id === parent.id));
    }
    // include any orphan sub-projects whose parent isn't active
    ordered.push(...list.filter((p) => p.parent_id && !parents.some((pp) => pp.id === p.parent_id)));
    return ordered;
  }

  async function handleOpen() {
    setTitle(defaultTitle);
    setBody(defaultBody ?? "");
    setCreatingOpen(false);
    setNewName("");
    // No project of its own → preselect the last project the user saved to.
    const preselect = defaultProjectId ?? readLastProject();
    setTargetId(preselect);
    setOpen(true);
    if (projects === null) {
      try {
        const { projects: list } = await api<{ projects: ProjectRow[] }>("/api/projects");
        const ordered = orderProjects(list);
        setProjects(ordered);
        // Remembered project no longer exists → fall back to "none chosen".
        if (preselect && !ordered.some((p) => p.id === preselect)) setTargetId("");
      } catch (e) {
        toast.error((e as Error).message);
        setProjects([]);
      }
    } else if (preselect && !projects.some((p) => p.id === preselect)) {
      setTargetId("");
    }
  }

  async function handleCreateProject() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const { project } = await api<{ project: ProjectRow }>("/api/projects", {
        method: "POST",
        body: { name },
      });
      setProjects((prev) => orderProjects([...(prev ?? []), project]));
      setTargetId(project.id);
      setCreatingOpen(false);
      setNewName("");
      toast.success(tBoard("projectCreated"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSave() {
    if (!title.trim() || !targetId) return;
    setSaving(true);
    try {
      await api(`/api/projects/${targetId}/info-items`, {
        method: "POST",
        body: { title: title.trim(), body: body.trim() },
      });
      writeLastProject(targetId);
      toast.success(targetId === defaultProjectId ? t("infoSaved") : t("infoSavedToOther"));
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const projName = (p: ProjectRow) => (locale === "he" && p.name_he ? p.name_he : p.name);

  return (
    <>
      <IconButton
        label={t("saveAsInfo")}
        color="green"
        onClick={handleOpen}
      >
        <StickyNote />
      </IconButton>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" dir={locale === "he" ? "rtl" : "ltr"} className="h-auto max-h-[80vh]">
          <SheetHeader>
            <SheetTitle className="text-start">{t("addInfoTitle")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("infoTitlePlaceholder")}
              className="min-h-[48px]"
              dir="auto"
              autoFocus
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("infoBodyPlaceholder")}
              className="min-h-[120px]"
              dir="auto"
            />
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">{t("infoTarget")}</p>
              <Select value={targetId} onValueChange={setTargetId} disabled={!projects}>
                <SelectTrigger>
                  <SelectValue placeholder={projects ? t("infoTargetPlaceholder") : tCommon("loading")} />
                </SelectTrigger>
                <SelectContent>
                  {(projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.parent_id ? `↳ ${projName(p)}` : projName(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Inline new-project creation */}
              {creatingOpen ? (
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={tBoard("newProjectPlaceholder")}
                    className="h-9"
                    dir="auto"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCreateProject();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={handleCreateProject}
                    disabled={creating || !newName.trim()}
                    className="shrink-0"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : tBoard("newProjectCreate")}
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => { setCreatingOpen(false); setNewName(""); }}
                    className="shrink-0"
                  >
                    {tCommon("cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm" variant="ghost"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => setCreatingOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tBoard("newProject")}
                </Button>
              )}

              {/* Explain why save is disabled instead of failing silently */}
              {!targetId && projects !== null && (
                <p className="text-xs text-status-warn">{tBoard("chooseProjectHint")}</p>
              )}
            </div>
            <Button
              onClick={handleSave}
              disabled={saving || !title.trim() || !targetId}
              className="w-full min-h-[48px]"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("infoSave")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
