"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Check, Plus, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

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

// A draft checklist row. `key` is a stable local id for React; the real
// ChecklistItem id is minted on submit so we match the backend shape exactly.
interface ChecklistDraft {
  key: string;
  title: string;
}

/**
 * ManualTaskInput — create a task by hand, no AI classification.
 *
 * Fields: title (required), description, a grow-on-demand checklist, and a
 * project + sub-project pair. The sub-project select is populated from the
 * children of the selected project; choosing one sets the task's project_id
 * to the sub-project (a task belongs to the deepest level chosen).
 *
 * Posts straight to POST /api/tasks, which stamps manually_verified=true.
 */
export function ManualTaskInput({ open, onClose, onCreated }: ManualTaskInputProps) {
  const t = useTranslations("manualTask");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [checklist, setChecklist] = useState<ChecklistDraft[]>([]);
  const [projectId, setProjectId] = useState("");
  const [subProjectId, setSubProjectId] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setChecklist([]);
    setProjectId("");
    setSubProjectId("");
    setLoading(false);
  }, []);

  // Load the project list once the sheet opens (cheap, and we need it up front
  // for the two selects). Refetch each open so newly-created projects appear.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const { projects: rows } = await api<{ projects: ProjectOption[] }>("/api/projects");
        if (!cancelled) setProjects(rows ?? []);
      } catch {
        // selects just stay empty — the task can still be created without one
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function handleClose() {
    reset();
    onClose();
  }

  const projectName = (p: ProjectOption) =>
    locale === "he" && p.name_he ? p.name_he : p.name;

  // Root projects: no parent, or a parent that isn't in our set (defensive).
  const byId = new Map(projects.map((p) => [p.id, p]));
  const rootProjects = projects.filter((p) => !p.parent_id || !byId.has(p.parent_id));
  const subProjects = projectId
    ? projects.filter((p) => p.parent_id === projectId)
    : [];

  function addChecklistItem() {
    setChecklist((prev) => [
      ...prev,
      { key: crypto.randomUUID(), title: "" },
    ]);
  }

  function updateChecklistItem(key: string, value: string) {
    setChecklist((prev) => prev.map((c) => (c.key === key ? { ...c, title: value } : c)));
  }

  function removeChecklistItem(key: string) {
    setChecklist((prev) => prev.filter((c) => c.key !== key));
  }

  async function handleCreate() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t("titleRequired"));
      return;
    }
    setLoading(true);
    try {
      const now = new Date().toISOString();
      const checklistItems = checklist
        .map((c) => c.title.trim())
        .filter((s) => s.length > 0)
        .map((itemTitle) => ({
          id: crypto.randomUUID(),
          title: itemTitle,
          done: false,
          created_at: now,
          completed_at: null,
          created_by: "user" as const,
        }));

      // A task lives at the deepest level the user picked: sub-project if
      // chosen, otherwise the top-level project, otherwise none.
      const effectiveProjectId = subProjectId || projectId || null;

      const body: Record<string, unknown> = {
        title: trimmedTitle,
        title_he: trimmedTitle,
        description: description.trim(),
      };
      if (checklistItems.length > 0) body.checklist = checklistItems;
      if (effectiveProjectId) body.project_id = effectiveProjectId;

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

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent side="bottom" className="h-auto max-h-[90vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start">{t("title")}</SheetTitle>
          <SheetDescription className="text-start">{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 py-4 overflow-y-auto">
          {/* Title */}
          <div>
            <label className="text-xs font-medium">{t("titleLabel")}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              dir="auto"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium">{t("descriptionLabel")}</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              dir="auto"
              className="min-h-[80px]"
            />
          </div>

          {/* Checklist */}
          <div className="space-y-2">
            <label className="text-xs font-medium">{t("checklistLabel")}</label>
            {checklist.length > 0 && (
              <div className="space-y-2">
                {checklist.map((item) => (
                  <div key={item.key} className="flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0">☐</span>
                    <Input
                      value={item.title}
                      onChange={(e) => updateChecklistItem(item.key, e.target.value)}
                      placeholder={t("checklistItemPlaceholder")}
                      dir="auto"
                      className="flex-1"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0"
                      onClick={() => removeChecklistItem(item.key)}
                      aria-label={tCommon("delete")}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={addChecklistItem}
            >
              <Plus className="h-4 w-4" />
              {t("addChecklistItem")}
            </Button>
          </div>

          {/* Project + sub-project */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium">{t("projectLabel")}</label>
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setSubProjectId(""); // children differ per parent — reset
                }}
                className="w-full rounded border px-2 py-1.5 text-sm bg-background"
                dir="auto"
              >
                <option value="">{t("noProject")}</option>
                {rootProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {projectName(p)}
                  </option>
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
                  <option key={p.id} value={p.id}>
                    {projectName(p)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Action row */}
        <div className="flex gap-2 sticky bottom-0 bg-background pt-3 border-t">
          <Button variant="outline" onClick={handleClose} className="min-h-[48px] gap-1">
            <X className="h-4 w-4" />
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={loading || !title.trim()}
            className="flex-1 min-h-[48px] gap-1"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("create")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
