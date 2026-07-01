"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";

type GenerationMode = "sts" | "tts";

interface Tab {
  id: string;
  title: string;
}

interface DriveDoc {
  id: string;
  name: string;
  url: string;
}

export function CreateProjectForm() {
  const t = useTranslations("smrtVoice.projects.form");
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<"he" | "en">("he");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState<string>("");
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [mode, setMode] = useState<GenerationMode>("tts");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Google Drive doc picker (alternative to pasting the link).
  const [docFolder, setDocFolder] = useState("");
  const [driveDocs, setDriveDocs] = useState<DriveDoc[] | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);

  async function loadDocs() {
    if (!docFolder.trim()) return;
    setLoadingDocs(true);
    try {
      const { files } = await api<{ files: DriveDoc[] }>("/api/voice/drive/list-docs", {
        method: "POST",
        body: { folder: docFolder },
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
      // Auto-pick the Hebrew-titled tab when present.
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
      const { project } = await api<{ project: { id: string } }>("/api/voice/projects", {
        method: "POST",
        body: {
          name,
          code: code || undefined,
          description: description || undefined,
          language,
          google_doc_url: googleDocUrl,
          google_doc_tab_id: tabId || undefined,
          google_doc_tab_title: selectedTab?.title || undefined,
          generation_mode: mode,
        },
      });
      router.push(`/${locale}/voice/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("name")}</label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("code")}</label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t("codePlaceholder")}
          maxLength={8}
        />
        <p className="text-xs text-muted-foreground">{t("codeHelp")}</p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("description")}</label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("language")}</label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={language}
          onChange={(e) => setLanguage(e.target.value as "he" | "en")}
        >
          <option value="he">עברית</option>
          <option value="en">English</option>
        </select>
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <label className="text-sm font-medium">{t("pickFromDrive")}</label>
        <div className="flex gap-2">
          <Input
            value={docFolder}
            onChange={(e) => setDocFolder(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
          />
          <Button
            type="button"
            variant="outline"
            onClick={loadDocs}
            disabled={!docFolder.trim() || loadingDocs}
          >
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
          onChange={(e) => setMode(e.target.value as GenerationMode)}
        >
          <option value="tts">{t("ttsMode")}</option>
          <option value="sts">{t("stsMode")}</option>
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
