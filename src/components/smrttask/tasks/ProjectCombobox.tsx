"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, Plus, X, Folder } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface ProjectOption {
  id: string;
  name: string;
  name_he: string | null;
  color: string | null;
  parent_id: string | null;
}

const PRESET_COLORS = [
  "#6366f1", "#3b82f6", "#10b981", "#f59e0b",
  "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6",
];

function pname(p: ProjectOption, locale: string) {
  return locale === "he" && p.name_he ? p.name_he : p.name;
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  locale: string;
  /** Pre-loaded projects list. When provided, the combobox won't fetch on open. */
  initialProjects?: ProjectOption[];
  /** Called when a new project is created, so the parent can add it to its list. */
  onProjectCreated?: (project: ProjectOption) => void;
}

export function ProjectCombobox({ value, onChange, locale, initialProjects, onProjectCreated }: Props) {
  const t = useTranslations("projectCombobox");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>(initialProjects ?? []);
  const [fetched, setFetched] = useState(!!initialProjects);

  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState("");
  const [createColor, setCreateColor] = useState(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const createNameRef = useRef<HTMLInputElement>(null);

  // Sync initialProjects when parent re-fetches
  useEffect(() => {
    if (initialProjects) { setProjects(initialProjects); setFetched(true); }
  }, [initialProjects]);

  // Fetch when dropdown opens
  useEffect(() => {
    if (!open || fetched) return;
    api<{ projects: ProjectOption[] }>("/api/projects")
      .then(({ projects: p }) => { setProjects(p ?? []); setFetched(true); })
      .catch(() => {});
  }, [open, fetched]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Auto-focus when dropdown/create opens
  useEffect(() => {
    if (open && !creating) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open, creating]);
  useEffect(() => {
    if (creating) setTimeout(() => createNameRef.current?.focus(), 50);
  }, [creating]);

  const topLevel = projects.filter((p) => !p.parent_id);
  const selected = projects.find((p) => p.id === value) ?? null;
  const selectedParent = selected?.parent_id ? projects.find((p) => p.id === selected.parent_id) ?? null : null;

  // Filter by search — include parent if any child matches, and vice-versa
  const q = search.toLowerCase();
  const matchIds = new Set(
    projects.filter((p) => pname(p, locale).toLowerCase().includes(q)).map((p) => p.id),
  );
  // Also include parents of matching sub-projects
  projects.forEach((p) => { if (p.parent_id && matchIds.has(p.id)) matchIds.add(p.parent_id); });

  // Show a parent if it matches OR if any of its children match
  const visibleTopLevel = topLevel.filter(
    (p) => matchIds.has(p.id) || projects.some((c) => c.parent_id === p.id && matchIds.has(c.id)),
  );

  async function handleCreate() {
    if (!createName.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: createName.trim(),
        color: createColor,
      };
      if (createParentId) body.parent_id = createParentId;

      const { project } = await api<{ project: ProjectOption }>("/api/projects", {
        method: "POST",
        body,
      });
      setProjects((prev) => [...prev, project]);
      onProjectCreated?.(project);
      onChange(project.id);
      toast.success(t("created"));
      setCreating(false);
      setCreateName("");
      setCreateParentId("");
      setCreateColor(PRESET_COLORS[0]);
      setOpen(false);
      setSearch("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function closeDropdown() {
    setOpen(false);
    setCreating(false);
    setSearch("");
  }

  function selectProject(id: string) {
    onChange(id);
    closeDropdown();
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        className="w-full rounded border px-2 py-1.5 text-sm bg-background text-start flex items-center justify-between gap-1 hover:bg-accent/50 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <span className="flex items-center gap-1.5 truncate min-w-0">
            {selectedParent && (
              <>
                <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground text-xs shrink-0 truncate max-w-[80px]">
                  {pname(selectedParent, locale)}
                </span>
                <span className="text-muted-foreground">/</span>
              </>
            )}
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: selected.color || "#888" }}
            />
            <span className="truncate">{pname(selected, locale)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t("none")}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[240px] rounded-md border bg-popover shadow-lg overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b">
            <Input
              ref={searchRef}
              placeholder={t("search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-sm"
            />
          </div>

          {/* Options list */}
          <div className="max-h-52 overflow-y-auto py-1">
            {/* Clear/none option */}
            <button
              type="button"
              className="w-full px-3 py-1.5 text-sm text-start hover:bg-accent flex items-center gap-2"
              onClick={() => selectProject("")}
            >
              <span className={cn("w-3 shrink-0", !value && "text-primary")}>
                {!value && <Check className="h-3 w-3" />}
              </span>
              <span className="text-muted-foreground">{t("none")}</span>
            </button>

            {/* Project tree */}
            {visibleTopLevel.map((parent) => {
              const children = projects.filter(
                (p) => p.parent_id === parent.id && matchIds.has(p.id),
              );
              const parentVisible = matchIds.has(parent.id);

              return (
                <div key={parent.id}>
                  {parentVisible && (
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-sm text-start hover:bg-accent flex items-center gap-2"
                      onClick={() => selectProject(parent.id)}
                    >
                      <span className="w-3 shrink-0">
                        {value === parent.id && <Check className="h-3 w-3 text-primary" />}
                      </span>
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: parent.color || "#888" }}
                      />
                      <span className="font-medium">{pname(parent, locale)}</span>
                    </button>
                  )}

                  {children.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className="w-full ps-7 pe-3 py-1.5 text-sm text-start hover:bg-accent flex items-center gap-2"
                      onClick={() => selectProject(child.id)}
                    >
                      <span className="w-3 shrink-0">
                        {value === child.id && <Check className="h-3 w-3 text-primary" />}
                      </span>
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: child.color || "#888" }}
                      />
                      <span>{pname(child, locale)}</span>
                    </button>
                  ))}
                </div>
              );
            })}

            {visibleTopLevel.length === 0 && search && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t("noResults")}</div>
            )}
          </div>

          {/* Create section */}
          <div className="border-t p-2">
            {creating ? (
              <div className="space-y-2">
                <Input
                  ref={createNameRef}
                  placeholder={t("namePlaceholder")}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="h-7 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") { setCreating(false); setCreateName(""); }
                  }}
                />

                {/* Parent selector */}
                <select
                  value={createParentId}
                  onChange={(e) => setCreateParentId(e.target.value)}
                  className="w-full rounded border px-2 py-1 text-xs bg-background"
                >
                  <option value="">{t("topLevel")}</option>
                  {topLevel.map((p) => (
                    <option key={p.id} value={p.id}>
                      {pname(p, locale)}
                    </option>
                  ))}
                </select>

                {/* Color picker */}
                <div className="flex gap-1 flex-wrap">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        background: c,
                        borderColor: createColor === c ? "white" : "transparent",
                        outline: createColor === c ? `2px solid ${c}` : "none",
                      }}
                      onClick={() => setCreateColor(c)}
                      title={c}
                    />
                  ))}
                </div>

                <div className="flex gap-1">
                  <Button
                    size="sm"
                    className="h-7 text-xs flex-1"
                    onClick={handleCreate}
                    disabled={saving || !createName.trim()}
                  >
                    {saving ? "..." : t("create")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => { setCreating(false); setCreateName(""); setCreateParentId(""); }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="w-full px-2 py-1.5 text-xs text-start hover:bg-accent rounded flex items-center gap-1.5 text-muted-foreground transition-colors"
                onClick={() => setCreating(true)}
              >
                <Plus className="h-3 w-3" />
                {t("createNew")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
