"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Pencil, Trash2, Loader2, Search, Sparkles, Paperclip, Pin, X,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { MarkdownLite } from "@/components/smrttask/common/MarkdownLite";
import { MarkdownTextarea } from "@/components/smrttask/common/MarkdownTextarea";

const MAX_FILE_BYTES = 7 * 1024 * 1024;

interface Attachment {
  id: string;
  filename: string;
  url: string;
  file_path: string;
  file_mime: string;
  file_size: number;
}

interface InfoItem {
  id: string;
  project_id: string | null;
  title: string;
  body: string;
  attachments: Attachment[] | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRef {
  id: string;
  name: string;
  name_he: string | null;
  color: string | null;
}

interface Props {
  projectId: string;
  initialSummary: string | null;
  initialSummaryUpdatedAt: string | null;
}

type ItemDialog =
  | null
  | { mode: "add" }
  | { mode: "edit"; item: InfoItem };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(((reader.result as string) ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function InfoBoard({ projectId, initialSummary, initialSummaryUpdatedAt }: Props) {
  const t = useTranslations("infoBoard");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  // ── board data ──────────────────────────────────────────────────────────
  const [items, setItems] = useState<InfoItem[]>([]);
  const [projectsMap, setProjectsMap] = useState<Record<string, ProjectRef>>({});
  const [loading, setLoading] = useState(true);

  // ── filters ─────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");

  // ── summary ─────────────────────────────────────────────────────────────
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState(initialSummaryUpdatedAt);
  const [building, setBuilding] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);

  // ── add / edit dialog ───────────────────────────────────────────────────
  const [dialog, setDialog] = useState<ItemDialog>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [savingItem, setSavingItem] = useState(false);

  const load = useCallback(async () => {
    try {
      const { items: list, projects } = await api<{
        items: InfoItem[];
        projects: Record<string, ProjectRef>;
      }>(`/api/projects/${projectId}/info-items?include_children=true`);
      setItems(list);
      setProjectsMap(projects);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const projName = useCallback((p: ProjectRef) =>
    (locale === "he" && p.name_he ? p.name_he : p.name), [locale]);

  const subProjects = useMemo(
    () => Object.values(projectsMap).filter((p) => p.id !== projectId),
    [projectsMap, projectId],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (projectFilter !== "all" && it.project_id !== projectFilter) return false;
      if (!q) return true;
      return it.title.toLowerCase().includes(q) || (it.body ?? "").toLowerCase().includes(q);
    });
  }, [items, search, projectFilter]);

  const summaryStale = useMemo(() => {
    if (!summary || !summaryUpdatedAt) return false;
    const cutoff = new Date(summaryUpdatedAt).getTime();
    return items.some((it) => new Date(it.created_at).getTime() > cutoff);
  }, [items, summary, summaryUpdatedAt]);

  function formatStamp(iso: string): string {
    return new Date(iso).toLocaleString(locale === "he" ? "he-IL" : "en-GB", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  // ── summary actions ───────────────────────────────────────────────────────
  async function buildSummary() {
    setBuilding(true);
    try {
      const res = await api<{ summary: string; updated_at: string }>(
        `/api/projects/${projectId}/info-summary`,
        { method: "POST" },
      );
      setSummary(res.summary);
      setSummaryUpdatedAt(res.updated_at);
      setEditingSummary(false);
      toast.success(t("summaryBuilt"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  async function saveSummary() {
    if (!summaryDraft.trim()) return;
    setSavingSummary(true);
    try {
      const res = await api<{ summary: string; updated_at: string }>(
        `/api/projects/${projectId}/info-summary`,
        { method: "PATCH", body: { summary: summaryDraft.trim() } },
      );
      setSummary(res.summary);
      setSummaryUpdatedAt(res.updated_at);
      setEditingSummary(false);
      toast.success(t("summarySaved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingSummary(false);
    }
  }

  // ── item actions ──────────────────────────────────────────────────────────
  function openAdd() {
    setTitle(""); setBody(""); setFile(null);
    setDialog({ mode: "add" });
  }

  function openEdit(item: InfoItem) {
    setTitle(item.title); setBody(item.body ?? ""); setFile(null);
    setDialog({ mode: "edit", item });
  }

  function onPickFile(f: File | null) {
    if (f && f.size > MAX_FILE_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setFile(f);
  }

  async function uploadAttachment(itemId: string, f: File) {
    const data = await fileToBase64(f);
    await api(`/api/projects/${projectId}/info-items/${itemId}/attachments`, {
      method: "POST",
      body: { filename: f.name, mime: f.type || undefined, data },
    });
  }

  async function saveItem() {
    if (!dialog) return;
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle && !trimmedBody && !file) return;
    setSavingItem(true);
    try {
      if (dialog.mode === "add") {
        const { item } = await api<{ item: InfoItem }>(
          `/api/projects/${projectId}/info-items`,
          {
            method: "POST",
            // Only a file, no text → use the filename as the title.
            body: { title: trimmedTitle || (trimmedBody ? "" : file?.name ?? ""), body: trimmedBody },
          },
        );
        if (file) await uploadAttachment(item.id, file);
      } else {
        await api(`/api/projects/${projectId}/info-items/${dialog.item.id}`, {
          method: "PATCH",
          body: { title: trimmedTitle, body: trimmedBody },
        });
        if (file) await uploadAttachment(dialog.item.id, file);
      }
      toast.success(t("itemSaved"));
      setDialog(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingItem(false);
    }
  }

  async function deleteItem(itemId: string) {
    if (!confirm(t("deleteConfirm"))) return;
    try {
      await api(`/api/projects/${projectId}/info-items/${itemId}`, { method: "DELETE" });
      toast.success(t("itemDeleted"));
      setItems((prev) => prev.filter((it) => it.id !== itemId));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const canSaveItem = !!(title.trim() || body.trim() || file);

  return (
    <div className="space-y-4">
      {/* Pinned AI summary */}
      <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Pin className="h-4 w-4 text-primary" />
            {t("summaryTitle")}
          </div>
          <div className="flex items-center gap-2">
            {summary && !editingSummary && (
              <Button
                size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
                onClick={() => { setSummaryDraft(summary); setEditingSummary(true); }}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t("summaryEdit")}
              </Button>
            )}
            <Button
              size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
              onClick={buildSummary}
              disabled={building || items.length === 0}
            >
              {building
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Sparkles className="h-3.5 w-3.5" />}
              {building
                ? t("summaryBuilding")
                : summary ? t("summaryRefresh") : t("summaryBuild")}
            </Button>
          </div>
        </div>

        {editingSummary ? (
          <div className="space-y-2">
            <MarkdownTextarea
              value={summaryDraft}
              onValueChange={setSummaryDraft}
              className="min-h-[140px] bg-background"
              dir="auto"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setEditingSummary(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={saveSummary}
                disabled={savingSummary || !summaryDraft.trim()}
              >
                {savingSummary
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : t("summarySave")}
              </Button>
            </div>
          </div>
        ) : summary ? (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              <MarkdownLite>{summary}</MarkdownLite>
            </p>
            <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
              {summaryUpdatedAt && (
                <span>{t("summaryUpdatedAt", { date: formatStamp(summaryUpdatedAt) })}</span>
              )}
              {summaryStale && (
                <span className="text-status-warn">{t("summaryStale")}</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("summaryEmpty")}</p>
        )}
      </div>

      {/* Toolbar: search + sub-project filter + add */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-8 h-9"
            dir="auto"
          />
        </div>
        <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={openAdd}>
          <Plus className="h-4 w-4" />
          {t("addItem")}
        </Button>
      </div>

      {subProjects.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={t("filterByProject")}>
          {[{ id: "all" }, ...subProjects].map((p) => {
            const active = projectFilter === p.id;
            const label = p.id === "all" ? t("filterAll") : projName(p as ProjectRef);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectFilter(p.id)}
                className={`rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "hover:bg-muted"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Board */}
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          {items.length === 0 ? t("empty") : t("noResults")}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((item) => {
            const itemProject = item.project_id ? projectsMap[item.project_id] : undefined;
            const isSubItem = !!itemProject && itemProject.id !== projectId;
            const showTitle = !!item.title && !(item.body ?? "").startsWith(item.title);
            return (
              <article key={item.id} className="rounded-lg border bg-card p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 space-y-1">
                    {isSubItem && (
                      <Badge variant="outline" className="text-[10px] gap-1">
                        {itemProject.color && (
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: itemProject.color }}
                          />
                        )}
                        {projName(itemProject)}
                      </Badge>
                    )}
                    {showTitle && (
                      <p className="text-sm font-medium leading-snug" dir="auto">{item.title}</p>
                    )}
                  </div>
                  <div className="flex items-center shrink-0">
                    <Button
                      size="sm" variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      onClick={() => openEdit(item)}
                      aria-label={t("editItem")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteItem(item.id)}
                      aria-label={t("deleteItem")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {item.body && (
                  <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap flex-1">
                    <MarkdownLite>{item.body}</MarkdownLite>
                  </p>
                )}

                {(item.attachments ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {(item.attachments ?? []).map((a) => (
                      <a
                        key={a.id}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-muted transition-colors max-w-full"
                        title={a.filename}
                      >
                        <Paperclip className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[160px]" dir="auto">{a.filename}</span>
                      </a>
                    ))}
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground mt-auto" dir="ltr">
                  {formatStamp(item.created_at)}
                </p>
              </article>
            );
          })}
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent dir={locale === "he" ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="text-start">
              {dialog?.mode === "edit" ? t("editDialogTitle") : t("addDialogTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              dir="auto"
              autoFocus
            />
            <MarkdownTextarea
              value={body}
              onValueChange={setBody}
              placeholder={t("bodyPlaceholder")}
              className="min-h-[140px]"
              dir="auto"
            />
            <p className="text-[11px] text-muted-foreground">{t("markdownHint")}</p>

            <div className="flex items-center gap-2 flex-wrap">
              <label className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs cursor-pointer hover:bg-muted transition-colors">
                <Paperclip className="h-3.5 w-3.5" />
                {t("attachFile")}
                <input
                  type="file"
                  className="sr-only"
                  onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                />
              </label>
              {file && (
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                  <span className="truncate max-w-[180px]" dir="auto">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    aria-label={tCommon("cancel")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>

            <Button
              onClick={saveItem}
              disabled={savingItem || !canSaveItem}
              className="w-full min-h-[44px]"
            >
              {savingItem ? <Loader2 className="h-4 w-4 animate-spin" /> : tCommon("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
