"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";

/**
 * v2: a "project" is a FOLDER — just a name, a letter code-prefix, and an
 * optional description. Scripts (Google Docs) live inside the folder and are
 * added on the folder page. No doc/tab/mode here anymore.
 */
export function CreateProjectForm() {
  const t = useTranslations("smrtVoice.folders");
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [description, setDescription] = useState("");
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
          code_prefix: prefix || undefined,
          description: description || undefined,
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
        <label className="text-sm font-medium">{t("prefix")}</label>
        <Input
          required
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
          placeholder={t("prefixPlaceholder")}
          maxLength={3}
          className="max-w-[8rem]"
        />
        <p className="text-xs text-muted-foreground">{t("prefixHelp")}</p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("description")}</label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !prefix}>
          {t("submit")}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
