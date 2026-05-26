"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";

type GenerationMode = "sts" | "tts";

export function CreateProjectForm() {
  const t = useTranslations("smrtVoice.projects.form");
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<"he" | "en">("he");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [mode, setMode] = useState<GenerationMode>("sts");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { project } = await api<{ project: { id: string } }>("/api/voice/projects", {
        method: "POST",
        body: {
          name,
          description: description || undefined,
          language,
          google_doc_url: googleDocUrl,
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
        <label className="text-sm font-medium">{t("description")}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
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

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("googleDocUrl")}</label>
        <Input
          required
          type="url"
          value={googleDocUrl}
          onChange={(e) => setGoogleDocUrl(e.target.value)}
          placeholder="https://docs.google.com/document/d/..."
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("generationMode")}</label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={mode}
          onChange={(e) => setMode(e.target.value as GenerationMode)}
        >
          <option value="sts">{t("stsMode")}</option>
          <option value="tts">{t("ttsMode")}</option>
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
