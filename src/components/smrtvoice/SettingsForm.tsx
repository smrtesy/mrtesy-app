"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

import { DriveFolderPicker } from "./DriveFolderPicker";

interface Settings {
  monthly_budget_usd: number;
  default_adapter: "resemble" | "chatterbox_local" | "chatterbox_runpod";
  default_resemble_model: string | null;
  default_llm_model: string | null;
  archive_after_days: number;
  gdrive_archive_folder_id: string | null;
  gdrive_archive_folder_url: string | null;
  postprocess_enabled: boolean;
  postprocess_compress: boolean;
  postprocess_speed: number;
  postprocess_normalize: boolean;
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
            gdrive_archive_folder_id: settings.gdrive_archive_folder_id,
            gdrive_archive_folder_url: settings.gdrive_archive_folder_url,
            postprocess_enabled: settings.postprocess_enabled,
            postprocess_compress: settings.postprocess_compress,
            postprocess_speed: settings.postprocess_speed,
            postprocess_normalize: settings.postprocess_normalize,
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

      <div className="space-y-1">
        <label className="text-sm font-medium">{t("archiveFolder")}</label>
        <div className="flex flex-wrap items-center gap-2">
          <DriveFolderPicker
            onPicked={(f) =>
              setSettings({
                ...settings,
                gdrive_archive_folder_id: f.id,
                gdrive_archive_folder_url: f.url,
              })
            }
          />
          {settings.gdrive_archive_folder_id ? (
            <>
              <a
                href={settings.gdrive_archive_folder_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                {settings.gdrive_archive_folder_url ?? settings.gdrive_archive_folder_id}
              </a>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSettings({
                    ...settings,
                    gdrive_archive_folder_id: null,
                    gdrive_archive_folder_url: null,
                  })
                }
              >
                {t("clearArchiveFolder")}
              </Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{t("noArchiveFolder")}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("archiveFolderHelp")}</p>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={settings.postprocess_enabled}
            onChange={(e) =>
              setSettings({ ...settings, postprocess_enabled: e.target.checked })
            }
          />
          {t("postprocess")}
        </label>
        {settings.postprocess_enabled && (
          <div className="space-y-2 ps-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.postprocess_normalize}
                onChange={(e) =>
                  setSettings({ ...settings, postprocess_normalize: e.target.checked })
                }
              />
              {t("postprocessNormalize")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.postprocess_compress}
                onChange={(e) =>
                  setSettings({ ...settings, postprocess_compress: e.target.checked })
                }
              />
              {t("postprocessCompress")}
            </label>
            <div className="space-y-1">
              <label className="text-sm">{t("postprocessSpeed")}</label>
              <Input
                type="number"
                min="0.5"
                max="2"
                step="0.05"
                value={settings.postprocess_speed}
                onChange={(e) =>
                  setSettings({ ...settings, postprocess_speed: Number(e.target.value) })
                }
              />
            </div>
          </div>
        )}
      </div>

      <Button type="submit" disabled={busy}>
        {t("save")}
      </Button>
    </form>
  );
}
