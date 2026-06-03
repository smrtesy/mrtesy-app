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
import { StickyNote, Loader2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface ProjectRow {
  id: string;
  name: string;
  name_he: string | null;
  parent_id: string | null;
}

/**
 * Note-icon action that saves a suggestion/task's content into a project's
 * Information Center. Defaults to the item's own project; the user can switch
 * to any project / sub-project. Project list is fetched lazily on first open.
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
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody ?? "");
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [targetId, setTargetId] = useState(defaultProjectId ?? "");
  const [saving, setSaving] = useState(false);

  async function handleOpen() {
    setTitle(defaultTitle);
    setBody(defaultBody ?? "");
    setTargetId(defaultProjectId ?? "");
    setOpen(true);
    if (projects === null) {
      try {
        const { projects: list } = await api<{ projects: ProjectRow[] }>("/api/projects");
        // parents first, each followed by its own sub-projects, for a readable list
        const parents = list.filter((p) => !p.parent_id);
        const ordered: ProjectRow[] = [];
        for (const parent of parents) {
          ordered.push(parent);
          ordered.push(...list.filter((c) => c.parent_id === parent.id));
        }
        // include any orphan sub-projects whose parent isn't active
        ordered.push(...list.filter((p) => p.parent_id && !parents.some((pp) => pp.id === p.parent_id)));
        setProjects(ordered);
      } catch (e) {
        toast.error((e as Error).message);
        setProjects([]);
      }
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
