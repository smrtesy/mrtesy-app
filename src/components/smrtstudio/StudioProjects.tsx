"use client";

/**
 * smrtStudio — the unified projects list (stage A of docs/studio-build-plan.md).
 *
 * Every production project in one place, with per-tab counts (voice / image /
 * video). Creation follows the house compact-UI rule: a quiet icon button that
 * expands into an inline name input, nothing permanent on screen.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";

import { api } from "@/lib/api/client";
import { PaneLink } from "@/lib/panes/nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StudioBalanceChip } from "@/components/smrtstudio/StudioBalanceChip";

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
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const create = useCallback(async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      await api("/api/studio/projects", {
        method: "POST",
        body: { name_he: name },
      });
      setNewName("");
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [newName, saving, load]);

  const displayName = (p: ProjectRow) =>
    locale === "en" && p.name_en ? p.name_en : p.name_he;

  return (
    <div className="mx-auto w-full max-w-4xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold flex-1">{t("title")}</h1>
        <StudioBalanceChip />
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
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {projects === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <PaneLink
                href={`/${locale}/studio/projects/${p.id}`}
                className="block rounded-lg border p-3 hover:bg-accent/50 transition-colors"
              >
                <div className="font-medium truncate">{displayName(p)}</div>
                <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                  <span>{t("tabVoice")} · {p.counts.voice}</span>
                  <span>{t("tabImage")} · {p.counts.image}</span>
                  <span>{t("tabVideo")} · {p.counts.video}</span>
                </div>
              </PaneLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
