"use client";

/**
 * smrtStudio — "הפקה" (Production): the single production surface.
 *
 * There is no separate projects-list step any more. The project is the only
 * organizational unit (docs/studio-hierarchy-plan.md): a compact selector at
 * the top picks (or creates) a project, and the full creation engine for that
 * project — voice / image / video tabs + its artifacts — renders inline below
 * via <StudioProject embedded>. Deep-linkable through ?project=<id>.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";

import { api } from "@/lib/api/client";
import { useScreenRouter, useScreenSearchParams } from "@/lib/panes/nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StudioBalanceChip } from "@/components/smrtstudio/StudioBalanceChip";
import { StudioProject } from "@/components/smrtstudio/StudioProject";

type ProjectRow = {
  id: string;
  name_he: string;
  name_en: string;
  status: string;
  created_at: string;
  counts: { voice: number; image: number; video: number };
};

export function StudioProjects() {
  const t = useTranslations("studioProjects");
  const locale = useLocale();
  const router = useScreenRouter();
  const searchParams = useScreenSearchParams();
  const urlProject = searchParams.get("project");

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { projects } = await api<{ projects: ProjectRow[] }>("/api/studio/projects");
      setProjects(projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Resolve the selected project once the list arrives: honor ?project= when it
  // points at a real project, otherwise keep the current pick or fall back to
  // the first (newest) one.
  useEffect(() => {
    if (!projects) return;
    setSelectedId((prev) => {
      if (urlProject && projects.some((p) => p.id === urlProject)) return urlProject;
      if (prev && projects.some((p) => p.id === prev)) return prev;
      return projects[0]?.id ?? null;
    });
  }, [projects, urlProject]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    // Keep the URL shareable without swapping the pane.
    const params = new URLSearchParams(searchParams.toString());
    params.set("project", id);
    router.replace(`/${locale}/studio/projects?${params.toString()}`);
  }, [router, locale, searchParams]);

  const create = useCallback(async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const { project } = await api<{ project: { id: string } }>("/api/studio/projects", {
        method: "POST",
        body: { name_he: name },
      });
      setNewName("");
      setCreating(false);
      await load();
      if (project?.id) select(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [newName, saving, load, select]);

  const displayName = (p: ProjectRow) =>
    locale === "en" && p.name_en ? p.name_en : p.name_he;

  return (
    <div className="mx-auto w-full max-w-5xl p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{t("productionTitle")}</h1>

        {projects && projects.length > 0 && !creating && (
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={selectedId ?? ""}
            onChange={(e) => select(e.target.value)}
            aria-label={t("selectProject")}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{displayName(p)}</option>
            ))}
          </select>
        )}

        {creating ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              placeholder={t("namePlaceholder")}
              className="h-8 w-56"
            />
            <Button size="sm" onClick={() => void create()} disabled={saving || !newName.trim()}>
              {t("create")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label={t("cancel")}
              onClick={() => { setCreating(false); setNewName(""); }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("newProject")}
            title={t("newProject")}
            onClick={() => setCreating(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}

        <div className="ms-auto">
          <StudioBalanceChip />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {projects === null ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : selectedId ? (
        // The production engine for the selected project, rendered inline.
        <StudioProject key={selectedId} projectId={selectedId} embedded />
      ) : null}
    </div>
  );
}
