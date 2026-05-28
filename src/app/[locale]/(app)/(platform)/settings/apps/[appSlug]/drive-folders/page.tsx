"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FolderOpen, Plus, Trash2, Search, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

interface Folder {
  id: string;
  name: string;
  parents?: string[];
}

export default function DriveFoldersPage() {
  const t = useTranslations("driveFolders");
  const { appSlug } = useParams() as { appSlug: string };

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);

  // Load current selection + folder names.
  const load = useCallback(async () => {
    setLoading(true);
    setDriveError(null);
    try {
      const settings = await api<{ settings: { drive_folder_ids: string[] | null; drive_folder_id: string | null } | null }>(
        "/api/me/settings",
        { noOrg: true },
      );
      const ids: string[] = (settings.settings?.drive_folder_ids && settings.settings.drive_folder_ids.length > 0)
        ? settings.settings.drive_folder_ids
        : (settings.settings?.drive_folder_id ? [settings.settings.drive_folder_id] : []);
      setSelectedIds(ids);

      if (ids.length === 0) {
        setSelectedFolders([]);
        return;
      }

      try {
        const r = await api<{ folders: Folder[] }>(
          `/api/me/drive/folders/by-id?ids=${encodeURIComponent(ids.join(","))}`,
          { noOrg: true },
        );
        setSelectedFolders(r.folders);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setDriveError(t("driveNotConnected"));
        } else if (e instanceof ApiError && e.status !== 401) {
          toast.error((e as Error).message);
        }
        // Fall back to showing the IDs without names so the user still
        // sees what's persisted.
        setSelectedFolders(ids.map((id) => ({ id, name: id })));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  async function persist(newIds: string[]) {
    setSaving(true);
    try {
      await api("/api/me/settings", {
        method: "PATCH",
        noOrg: true,
        body: { drive_folder_ids: newIds },
      });
      setSelectedIds(newIds);
      toast.success(t("saved"));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function handleRemove(id: string) {
    persist(selectedIds.filter((x) => x !== id));
  }

  function handleAdd(folders: Folder[]) {
    const next = Array.from(new Set([...selectedIds, ...folders.map((f) => f.id)]));
    persist(next);
    setPickerOpen(false);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            {t("title")}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {driveError && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{driveError}</span>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
            </div>
          ) : selectedFolders.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          ) : (
            <ul className="space-y-2">
              {selectedFolders.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate" dir="auto">{f.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-red-500"
                    onClick={() => handleRemove(f.id)}
                    disabled={saving}
                    aria-label={t("remove")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Button
            onClick={() => setPickerOpen(true)}
            disabled={saving || !!driveError}
            className="min-h-[48px] w-full gap-2"
          >
            <Plus className="h-4 w-4" />
            {t("addFolder")}
          </Button>

          <p className="text-xs text-muted-foreground">
            {t("recursiveNote")}
          </p>
        </CardContent>
      </Card>

      <FolderPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handleAdd}
        excludeIds={selectedIds}
      />

      <Card className="border-dashed">
        <CardContent className="p-4 text-xs text-muted-foreground">
          App: <code className="font-mono">{appSlug}</code>
        </CardContent>
      </Card>
    </div>
  );
}

function FolderPicker({
  open,
  onClose,
  onPick,
  excludeIds,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (folders: Folder[]) => void;
  excludeIds: string[];
}) {
  const t = useTranslations("driveFolders");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, Folder>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = q.trim()
        ? `/api/me/drive/folders?q=${encodeURIComponent(q.trim())}&limit=50`
        : "/api/me/drive/folders?limit=50";
      const r = await api<{ folders: Folder[] }>(url, { noOrg: true });
      setResults(r.folders.filter((f) => !excludeIds.includes(f.id)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(t("driveNotConnected"));
      } else if (e instanceof ApiError && e.status !== 401) {
        toast.error((e as Error).message);
      }
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [excludeIds, t]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPicked(new Map());
    setError(null);
    search("");
  }, [open, search]);

  // Debounced search on query change.
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => search(query), 250);
    return () => clearTimeout(h);
  }, [query, open, search]);

  function toggle(f: Folder) {
    const next = new Map(picked);
    if (next.has(f.id)) next.delete(f.id);
    else next.set(f.id, f);
    setPicked(next);
  }

  function confirm() {
    onPick(Array.from(picked.values()));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-9"
            autoFocus
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="max-h-[300px] overflow-y-auto space-y-1">
          {loading ? (
            <div className="py-6 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("noResults")}
            </p>
          ) : (
            results.map((f) => {
              const isPicked = picked.has(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggle(f)}
                  className={`flex items-center gap-2 w-full rounded-md p-2 text-start text-sm transition-colors hover:bg-accent ${isPicked ? "bg-primary/10" : ""}`}
                >
                  <div className={`h-4 w-4 shrink-0 rounded border ${isPicked ? "bg-primary border-primary" : "border-muted-foreground"}`}>
                    {isPicked && <span className="block text-center text-[10px] leading-4 text-white">✓</span>}
                  </div>
                  <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate" dir="auto">{f.name}</span>
                </button>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={confirm} disabled={picked.size === 0}>
            {t("addSelected", { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
