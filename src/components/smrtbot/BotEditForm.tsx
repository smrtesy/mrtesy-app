"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

interface Bot {
  id: string;
  name: string;
  slug: string;
  initials: string | null;
  timezone: string | null;
  admin_phones: string | null;
  active: boolean;
  live_wa_phone_number_id: string | null;
  live_wa_access_token: string | null;
  live_verify_token: string | null;
  live_phone_display: string | null;
  test_wa_phone_number_id: string | null;
  test_wa_access_token: string | null;
  test_verify_token: string | null;
  test_phone_display: string | null;
}

// Fields the form edits (must match the backend BOT_UPDATABLE whitelist).
const FIELDS = [
  "name", "slug", "initials", "timezone", "admin_phones",
  "live_wa_phone_number_id", "live_wa_access_token", "live_verify_token", "live_phone_display",
  "test_wa_phone_number_id", "test_wa_access_token", "test_verify_token", "test_phone_display",
] as const;
type Field = (typeof FIELDS)[number];

export function BotEditForm({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { bot } = await api<{ bot: Bot }>(`/api/bot/bots/${botId}`);
      const next: Record<string, string> = {};
      for (const f of FIELDS) next[f] = (bot[f] as string | null) ?? "";
      setForm(next);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  function set(field: Field, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

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

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!loaded) return <p className="text-sm text-muted-foreground">…</p>;

  const field = (f: Field, opts?: { ltr?: boolean }) => (
    <div className="space-y-1">
      <label className="text-sm font-medium">{t(`f_${f}`)}</label>
      <Input
        dir={opts?.ltr ? "ltr" : undefined}
        value={form[f] ?? ""}
        onChange={(e) => set(f, e.target.value)}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <Tabs defaultValue="basic">
        <TabsList>
          <TabsTrigger value="basic">{t("tabBasic")}</TabsTrigger>
          <TabsTrigger value="live">{t("tabLive")}</TabsTrigger>
          <TabsTrigger value="test">{t("tabTest")}</TabsTrigger>
        </TabsList>

        <TabsContent value="basic">
          <Card><CardContent className="space-y-3 pt-6">
            {field("name")}
            {field("slug", { ltr: true })}
            {field("initials", { ltr: true })}
            {field("timezone", { ltr: true })}
            {field("admin_phones", { ltr: true })}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="live">
          <Card><CardContent className="space-y-3 pt-6">
            {field("live_wa_phone_number_id", { ltr: true })}
            {field("live_wa_access_token", { ltr: true })}
            {field("live_verify_token", { ltr: true })}
            {field("live_phone_display", { ltr: true })}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="test">
          <Card><CardContent className="space-y-3 pt-6">
            {field("test_wa_phone_number_id", { ltr: true })}
            {field("test_wa_access_token", { ltr: true })}
            {field("test_verify_token", { ltr: true })}
            {field("test_phone_display", { ltr: true })}
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      <Button onClick={save} disabled={saving}>
        {saving ? "…" : t("save")}
      </Button>
    </div>
  );
}
