"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderOpen, Folder, ChevronLeft, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api/client";

interface DriveFolder {
  id: string;
  name: string;
  url: string;
}

/**
 * In-app Google Drive folder browser — no Google API key required (reuses the
 * user's Drive OAuth via our backend). Browse the tree and pick a folder;
 * returns { id, name, url }. This replaces the Google Picker widget which
 * needed a separately-provisioned browser API key.
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
  // Breadcrumb of opened folders; empty = My Drive root.
  const [stack, setStack] = useState<DriveFolder[]>([]);

  const loadFolders = useCallback(async (parent: string | undefined) => {
    setLoading(true);
    try {
      const { folders } = await api<{ folders: DriveFolder[] }>(
        "/api/voice/drive/list-folders",
        { method: "POST", body: { parent: parent ?? "" } },
      );
      setFolders(folders);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  function openDialog() {
    setOpen(true);
    setStack([]);
    loadFolders(undefined);
  }

  function drillInto(folder: DriveFolder) {
    setStack((s) => [...s, folder]);
    loadFolders(folder.id);
  }

  function goToLevel(index: number) {
    // index === -1 → root
    const next = index < 0 ? [] : stack.slice(0, index + 1);
    setStack(next);
    loadFolders(next.length ? next[next.length - 1].id : undefined);
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
        <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("browseTitle")}</DialogTitle>
          </DialogHeader>

          {/* Breadcrumb */}
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" dir="rtl">
            <button type="button" className="hover:underline" onClick={() => goToLevel(-1)}>
              {t("driveRoot")}
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

          {/* Select-current shortcut (only when inside a folder) */}
          {current && (
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
              <p className="p-3 text-sm text-muted-foreground">{t("noSubfolders")}</p>
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
