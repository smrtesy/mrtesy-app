"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
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
}

// Identity fields only. WhatsApp connection (official creds or unofficial
// pairing) lives in the transport-aware "WhatsApp" tab.
const FIELDS = ["name", "slug", "initials", "timezone", "admin_phones"] as const;
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
      <Card><CardContent className="space-y-3 pt-6">
        {field("name")}
        {field("slug", { ltr: true })}
        {field("initials", { ltr: true })}
        {field("timezone", { ltr: true })}
        {field("admin_phones", { ltr: true })}
      </CardContent></Card>

      <Button onClick={save} disabled={saving}>
        {saving ? "…" : t("save")}
      </Button>
    </div>
  );
}
