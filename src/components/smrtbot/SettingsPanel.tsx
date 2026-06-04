"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

interface Setting { id: string; key: string; value: string; description: string | null }

/** Per-bot key/value settings (automation_status, game_enabled, diamonds config, …). */
export function SettingsPanel({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const load = useCallback(async () => {
    try {
      const { settings } = await api<{ settings: Setting[] }>(`/api/bot/${botId}/settings`);
      setSettings(settings);
      setDraft(Object.fromEntries(settings.map((s) => [s.key, s.value])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  async function put(key: string, value: string) {
    try {
      await api(`/api/bot/${botId}/settings/${encodeURIComponent(key)}`, { method: "PUT", body: { value } });
      toast.success(t("updated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }

  async function addNew() {
    if (!newKey.trim()) return;
    await put(newKey.trim(), newVal);
    setNewKey("");
    setNewVal("");
    await load();
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (settings === null) return <p className="text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          {settings.map((s) => (
            <div key={s.id} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="font-mono text-xs text-muted-foreground" dir="ltr">{s.key}</label>
                <Input
                  dir="auto"
                  value={draft[s.key] ?? ""}
                  onChange={(e) => setDraft((p) => ({ ...p, [s.key]: e.target.value }))}
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => put(s.key, draft[s.key] ?? "")}>
                {t("save")}
              </Button>
            </div>
          ))}
          {settings.length === 0 && <p className="text-sm text-muted-foreground">{t("noItems")}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <label className="text-sm font-medium">{t("settingsAddNew")}</label>
          <div className="flex items-end gap-2">
            <Input dir="ltr" placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            <Input dir="auto" placeholder="value" value={newVal} onChange={(e) => setNewVal(e.target.value)} />
            <Button onClick={addNew} disabled={!newKey.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
