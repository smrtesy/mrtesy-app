"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, Loader2, Save } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Sender {
  id: string;
  email: string;
  label: string | null;
  reply_to: string | null;
}

interface Settings {
  default_region: string;
  region_by_language: Record<string, string>;
}

export function ReachSettingsPanel() {
  const t = useTranslations("smrtReach");

  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [newSender, setNewSender] = useState({ email: "", label: "" });
  const [adding, setAdding] = useState(false);

  const [regionEn, setRegionEn] = useState("us-east-1");
  const [regionHe, setRegionHe] = useState("il-central-1");
  const [savingRegions, setSavingRegions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ senders }, { settings }] = await Promise.all([
        api<{ senders: Sender[] }>("/api/reach/senders"),
        api<{ settings: Settings }>("/api/reach/settings"),
      ]);
      setSenders(senders);
      setRegionEn(settings.region_by_language?.en ?? "us-east-1");
      setRegionHe(settings.region_by_language?.he ?? "il-central-1");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addSender() {
    if (!newSender.email.trim()) return;
    setAdding(true);
    try {
      await api("/api/reach/senders", {
        method: "POST",
        body: { email: newSender.email.trim(), label: newSender.label.trim() || null },
      });
      toast.success(t("senderAdded"));
      setNewSender({ email: "", label: "" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function deleteSender(id: string) {
    try {
      await api(`/api/reach/senders/${id}`, { method: "DELETE" });
      setSenders((s) => s.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveRegions() {
    setSavingRegions(true);
    try {
      await api("/api/reach/settings", {
        method: "PUT",
        body: { region_by_language: { en: regionEn.trim(), he: regionHe.trim() } },
      });
      toast.success(t("settingsSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingRegions(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 rounded-lg border p-5">
      {/* Senders */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t("sendersTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("sendersSubtitle")}</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder={t("senderEmail")}
            value={newSender.email}
            onChange={(e) => setNewSender((s) => ({ ...s, email: e.target.value }))}
            className="sm:max-w-xs"
          />
          <Input
            placeholder={t("senderLabel")}
            value={newSender.label}
            onChange={(e) => setNewSender((s) => ({ ...s, label: e.target.value }))}
            className="sm:max-w-xs"
          />
          <Button onClick={addSender} disabled={adding} className="gap-2">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("add")}
          </Button>
        </div>

        {senders.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noSenders")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {senders.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm">
                  {s.email}
                  {s.label && <span className="text-muted-foreground"> · {s.label}</span>}
                </span>
                <Button variant="ghost" size="icon" onClick={() => deleteSender(s.id)} aria-label={t("delete")}>
                  <Trash2 className="h-4 w-4 text-status-late" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Region by language */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t("regionTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("regionSubtitle")}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("regionEn")}</span>
            <Input value={regionEn} onChange={(e) => setRegionEn(e.target.value)} className="sm:w-44" />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("regionHe")}</span>
            <Input value={regionHe} onChange={(e) => setRegionHe(e.target.value)} className="sm:w-44" />
          </label>
          <Button onClick={saveRegions} disabled={savingRegions} variant="outline" className="gap-2">
            {savingRegions ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("saveSettings")}
          </Button>
        </div>
      </section>
    </div>
  );
}
