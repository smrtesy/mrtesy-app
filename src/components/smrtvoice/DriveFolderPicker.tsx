"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderOpen, Folder, ChevronLeft, Check, Search, Users, HardDrive } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface DriveFolder {
  id: string;
  name: string;
  url: string;
}

/**
 * In-app Google Drive folder browser — no Google API key required (reuses the
 * user's Drive OAuth via our backend). Browse My Drive or "Shared with me",
 * search by name across your Drive, drill into subfolders, and pick a folder.
 */
export function DriveFolderPicker({
  onPicked,
}: {
  onPicked: (folder: DriveFolder) => void;
}) {
  const t = useTranslations("smrtVoice.scripts");
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sharedRoot, setSharedRoot] = useState(false);
  // Breadcrumb of opened folders; empty = the current root (My Drive / Shared).
  const [stack, setStack] = useState<DriveFolder[]>([]);

  const searching = search.trim().length > 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const q = search.trim();
      const body: Record<string, unknown> = q
        ? { q }
        : stack.length
          ? { parent: stack[stack.length - 1].id }
          : sharedRoot
            ? { shared: true }
            : { parent: "" };
      const { folders } = await api<{ folders: DriveFolder[] }>(
        "/api/voice/drive/list-folders",
        { method: "POST", body },
      );
      setFolders(folders);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [search, stack, sharedRoot]);

  // Reload on any state change (debounced while typing a search).
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => refresh(), searching ? 350 : 0);
    return () => clearTimeout(h);
  }, [open, refresh, searching]);

  function openDialog() {
    setSearch("");
    setSharedRoot(false);
    setStack([]);
    setFolders([]);
    setOpen(true);
  }

  function drillInto(folder: DriveFolder) {
    setSearch(""); // drilling exits search mode
    setStack((s) => [...s, folder]);
  }

  function goToLevel(index: number) {
    setSearch("");
    setStack((s) => (index < 0 ? [] : s.slice(0, index + 1)));
  }

  function switchSource(shared: boolean) {
    setSearch("");
    setStack([]);
    setSharedRoot(shared);
  }

  function pick(folder: DriveFolder) {
    onPicked(folder);
    setOpen(false);
  }

  const current = stack[stack.length - 1];

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog}>
        <FolderOpen className="h-4 w-4 me-1" />
        {t("browseDrive")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>{t("browseTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("browseTitle")}</DialogDescription>
          </DialogHeader>

          {/* Search */}
          <div className="relative">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchFolders")}
              className="ps-8"
            />
          </div>

          {/* Source toggle (hidden while searching) */}
          {!searching && (
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={!sharedRoot ? "default" : "outline"}
                onClick={() => switchSource(false)}
              >
                <HardDrive className="h-4 w-4 me-1" /> {t("driveRoot")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sharedRoot ? "default" : "outline"}
                onClick={() => switchSource(true)}
              >
                <Users className="h-4 w-4 me-1" /> {t("sharedWithMe")}
              </Button>
            </div>
          )}

          {/* Breadcrumb (browse mode only) */}
          {!searching ? (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" dir="rtl">
              <button type="button" className="hover:underline" onClick={() => goToLevel(-1)}>
                {sharedRoot ? t("sharedWithMe") : t("driveRoot")}
              </button>
              {stack.map((f, i) => (
                <span key={f.id} className="flex items-center gap-1">
                  <span>/</span>
                  <button type="button" className="hover:underline truncate max-w-[8rem]" onClick={() => goToLevel(i)}>
                    {f.name}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">{t("searchResults")}</div>
          )}

          {/* Select-current shortcut (inside a folder, not searching) */}
          {!searching && current && (
            <Button size="sm" onClick={() => pick(current)}>
              <Check className="h-4 w-4 me-1" />
              {t("selectThisFolder")}: {current.name}
            </Button>
          )}

          {/* Folder list */}
          <div className="flex-1 overflow-y-auto rounded-md border divide-y" dir="rtl">
            {loading ? (
              <p className="p-3 text-sm text-muted-foreground">…</p>
            ) : folders.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {searching ? t("noMatches") : t("noSubfolders")}
              </p>
            ) : (
              folders.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-2 p-2">
                  <button
                    type="button"
                    onClick={() => drillInto(f)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-start hover:underline"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                    <ChevronLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                  <Button size="sm" variant="secondary" onClick={() => pick(f)}>
                    {t("selectFolder")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
