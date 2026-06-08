"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

const FIELDS = [
  "live_wa_phone_number_id", "live_wa_access_token", "live_verify_token", "live_phone_display",
  "test_wa_phone_number_id", "test_wa_access_token", "test_verify_token", "test_phone_display",
] as const;
type Field = (typeof FIELDS)[number];

/** Official (Meta Cloud API) WhatsApp credentials — live + test environments.
 *  Shown in the WhatsApp tab when the bot is on the `meta` transport. */
export function MetaCredentialsForm({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [form, setForm] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { bot } = await api<{ bot: Record<string, string | null> }>(`/api/bot/bots/${botId}`);
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f] = (bot[f] as string | null) ?? "";
    setForm(next);
    setLoaded(true);
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/bot/bots/${botId}`, { method: "PATCH", body: form });
      toast.success(t("updated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">…</p>;

  const field = (f: Field) => (
    <div className="space-y-1">
      <label className="text-sm font-medium">{t(`f_${f}`)}</label>
      <Input dir="ltr" value={form[f] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f]: e.target.value }))} />
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("tabLive")}</h2>
          {field("live_wa_phone_number_id")}
          {field("live_wa_access_token")}
          {field("live_verify_token")}
          {field("live_phone_display")}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="font-semibold">{t("tabTest")}</h2>
          {field("test_wa_phone_number_id")}
          {field("test_wa_access_token")}
          {field("test_verify_token")}
          {field("test_phone_display")}
        </CardContent>
      </Card>
      <Button onClick={save} disabled={saving}>
        {saving ? "…" : t("save")}
      </Button>
    </div>
  );
}
