"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

interface Setting { key: string; value: string }

const MODELS = ["claude-haiku", "claude-sonnet", "claude-opus", "gemini"] as const;
const isOn = (v: string) => ["true", "on", "1", "yes"].includes((v ?? "").trim().toLowerCase());

/** Structured control for the bot's optional AI answering: enable toggle +
 *  model picker (Claude Haiku/Sonnet/Opus or Gemini — the platform's models
 *  and keys). Persists to smrtbot_settings (ai_enabled / ai_model). */
export function BotAiSettings({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState<string>("claude-haiku");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { settings } = await api<{ settings: Setting[] }>(`/api/bot/${botId}/settings`);
      const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      setEnabled(isOn(byKey["ai_enabled"] ?? ""));
      setModel(byKey["ai_model"] || "claude-haiku");
      setLoaded(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/bot/${botId}/settings/ai_enabled`, { method: "PUT", body: { value: enabled ? "TRUE" : "FALSE" } });
      await api(`/api/bot/${botId}/settings/ai_model`, { method: "PUT", body: { value: model } });
      toast.success(t("updated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <h2 className="text-sm font-semibold">{t("aiTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("aiHint")}</p>
        </div>

        <label className="flex items-start gap-3">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>
            <span className="block text-sm font-medium">{t("aiEnable")}</span>
            <span className="block text-xs text-muted-foreground">{t("aiEnableHint")}</span>
          </span>
        </label>

        <div className="space-y-1">
          <label className="text-sm font-medium">{t("aiModel")}</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!enabled}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>{t(`aiModel_${m.replace("-", "_")}`)}</option>
            ))}
          </select>
        </div>

        <Button onClick={save} disabled={saving}>{saving ? "…" : t("save")}</Button>
      </CardContent>
    </Card>
  );
}
