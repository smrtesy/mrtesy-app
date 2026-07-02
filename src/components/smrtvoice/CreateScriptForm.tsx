"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

import { DriveFolderPicker } from "./DriveFolderPicker";

interface Tab {
  id: string;
  title: string;
}
interface DriveDoc {
  id: string;
  name: string;
  url: string;
}

/** Adds a script (Google Doc + tab) to a folder. Code is auto-assigned server-side. */
export function CreateScriptForm({
  projectId,
  nextCode,
  onCreated,
}: {
  projectId: string;
  nextCode: string;
  onCreated?: () => void;
}) {
  const t = useTranslations("smrtVoice.scripts");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [mode, setMode] = useState<"tts" | "sts">("tts");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState("");
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [docFolder, setDocFolder] = useState("");
  const [driveDocs, setDriveDocs] = useState<DriveDoc[] | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);

  function reset() {
    setName("");
    setGoogleDocUrl("");
    setMode("tts");
    setTabs([]);
    setTabId("");
    setDriveDocs(null);
    setDocFolder("");
    setError(null);
  }

  async function loadDocs(folderArg?: string) {
    const folder = (folderArg ?? docFolder).trim();
    if (!folder) return;
    setLoadingDocs(true);
    try {
      const { files } = await api<{ files: DriveDoc[] }>("/api/voice/drive/list-docs", {
        method: "POST",
        body: { folder },
      });
      setDriveDocs(files);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingDocs(false);
    }
  }

  function pickDoc(doc: DriveDoc) {
    setGoogleDocUrl(doc.url);
    setTabs([]);
    setTabId("");
    setDriveDocs(null);
  }

  async function loadTabs() {
    if (!googleDocUrl) return;
    setLoadingTabs(true);
    try {
      const { tabs } = await api<{ tabs: Tab[] }>("/api/voice/doc-tabs", {
        method: "POST",
        body: { google_doc_url: googleDocUrl },
      });
      setTabs(tabs);
      const hebrew = tabs.find((tab) => /[֐-׿]/.test(tab.title));
      setTabId((hebrew ?? tabs[0])?.id ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingTabs(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const selectedTab = tabs.find((tab) => tab.id === tabId);
      await api("/api/voice/projects/" + projectId + "/scripts", {
        method: "POST",
        body: {
          name: name || undefined,
          google_doc_url: googleDocUrl,
          google_doc_tab_id: tabId || undefined,
          google_doc_tab_title: selectedTab?.title || undefined,
          generation_mode: mode,
        },
      });
      setOpen(false);
      reset();
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">{t("newScript")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("newScript")} · <span className="font-mono">{nextCode}</span>
          </DialogTitle>
          <DialogDescription>{t("autoNumberHint", { code: nextCode })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("name")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </div>

          <div className="space-y-1 rounded-md border p-3">
            <label className="text-sm font-medium">{t("pickFromDrive")}</label>
            <div className="flex flex-wrap gap-2">
              <DriveFolderPicker
                onPicked={(f) => {
                  setDocFolder(f.url);
                  loadDocs(f.id);
                }}
              />
              <Input
                value={docFolder}
                onChange={(e) => setDocFolder(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/..."
                className="flex-1 min-w-[10rem]"
              />
              <Button type="button" variant="outline" onClick={() => loadDocs()} disabled={!docFolder.trim() || loadingDocs}>
                {loadingDocs ? t("loadingDocs") : t("loadDocs")}
              </Button>
            </div>
            {driveDocs && driveDocs.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("noDocs")}</p>
            )}
            {driveDocs && driveDocs.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {driveDocs.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => pickDoc(doc)}
                    className="block w-full text-start rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    {doc.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("googleDocUrl")}</label>
            <div className="flex gap-2">
              <Input
                required
                type="url"
                value={googleDocUrl}
                onChange={(e) => setGoogleDocUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/..."
              />
              <Button type="button" variant="outline" onClick={loadTabs} disabled={!googleDocUrl || loadingTabs}>
                {loadingTabs ? t("loadingTabs") : t("loadTabs")}
              </Button>
            </div>
          </div>

          {tabs.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("tab")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={tabId}
                onChange={(e) => setTabId(e.target.value)}
              >
                {tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {tab.title || tab.id}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("tabHelp")}</p>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("generationMode")}</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as "tts" | "sts")}
            >
              <option value="tts">{t("ttsMode")}</option>
              <option value="sts">{t("stsMode")}</option>
            </select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !googleDocUrl}>
              {t("create")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
