"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface Settings {
  monthly_budget_usd: number;
  default_adapter: "resemble" | "chatterbox_local" | "chatterbox_runpod";
  default_resemble_model: string | null;
  default_llm_model: string | null;
  archive_after_days: number;
}

export function SettingsForm() {
  const t = useTranslations("smrtVoice.settings");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { settings } = await api<{ settings: Settings }>("/api/voice/settings");
        if (mounted) setSettings(settings);
      } catch (err) {
        if (mounted) toast.error(err instanceof Error ? err.message : "Failed to load");
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      const { settings: saved } = await api<{ settings: Settings }>(
        "/api/voice/settings",
        {
          method: "PATCH",
          body: {
            monthly_budget_usd: settings.monthly_budget_usd,
            default_adapter: settings.default_adapter,
            default_resemble_model: settings.default_resemble_model,
            default_llm_model: settings.default_llm_model,
            archive_after_days: settings.archive_after_days,
          },
        },
      );
      setSettings(saved);
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("monthlyBudget")}</label>
        <Input
          type="number"
          min="0"
          step="1"
          value={settings.monthly_budget_usd}
          onChange={(e) =>
            setSettings({ ...settings, monthly_budget_usd: Number(e.target.value) })
          }
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("defaultAdapter")}</label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={settings.default_adapter}
          onChange={(e) =>
            setSettings({
              ...settings,
              default_adapter: e.target.value as Settings["default_adapter"],
            })
          }
        >
          <option value="resemble">resemble</option>
          <option value="chatterbox_local">chatterbox_local</option>
          <option value="chatterbox_runpod">chatterbox_runpod</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("defaultModel")}</label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={settings.default_resemble_model ?? ""}
          onChange={(e) =>
            setSettings({
              ...settings,
              default_resemble_model: e.target.value || null,
            })
          }
        >
          <option value="">(default)</option>
          <option value="chatterbox">chatterbox</option>
          <option value="chatterbox-turbo">chatterbox-turbo</option>
          <option value="resemble-ultra">resemble-ultra</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("defaultLlmModel")}</label>
        {/* Free text rather than a fixed dropdown — Claude model IDs change
            over time, and the studio may have access to specific models.
            Empty = use voice-engine's LLM_MODEL env default. */}
        <Input
          type="text"
          value={settings.default_llm_model ?? ""}
          onChange={(e) =>
            setSettings({
              ...settings,
              default_llm_model: e.target.value.trim() || null,
            })
          }
          placeholder={t("defaultLlmModelDefault")}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("archiveAfterDays")}</label>
        <Input
          type="number"
          min="1"
          value={settings.archive_after_days}
          onChange={(e) =>
            setSettings({ ...settings, archive_after_days: Number(e.target.value) })
          }
        />
      </div>

      <Button type="submit" disabled={busy}>
        {t("save")}
      </Button>
    </form>
  );
}
