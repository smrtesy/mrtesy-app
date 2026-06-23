"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Loader2, Save, ArrowRight, Mail, AtSign, AlertCircle } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface Sender {
  id: string;
  email: string;
  label: string | null;
  reply_to: string | null;
  provider: string;
  daily_cap: number | null;
}
interface GmailAccount { sender_id: string; email: string; disabled: boolean; last_error: string | null }
interface Settings { default_region: string; region_by_language: Record<string, string> }

export function ReachSettingsClient() {
  const t = useTranslations("smrtReach");
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();

  const [senders, setSenders] = useState<Sender[]>([]);
  const [gmailStatus, setGmailStatus] = useState<Map<string, GmailAccount>>(new Map());
  const [loading, setLoading] = useState(true);
  const [newSender, setNewSender] = useState({ email: "", label: "", daily_cap: "" });
  const [adding, setAdding] = useState(false);

  const [regionEn, setRegionEn] = useState("us-east-1");
  const [regionHe, setRegionHe] = useState("il-central-1");
  const [savingRegions, setSavingRegions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ senders }, { accounts }, { settings }] = await Promise.all([
        api<{ senders: Sender[] }>("/api/reach/senders"),
        api<{ accounts: GmailAccount[] }>("/api/reach/gmail-accounts"),
        api<{ settings: Settings }>("/api/reach/settings"),
      ]);
      setSenders(senders);
      setGmailStatus(new Map(accounts.map((a) => [a.sender_id, a])));
      setRegionEn(settings.region_by_language?.en ?? "us-east-1");
      setRegionHe(settings.region_by_language?.he ?? "il-central-1");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Surface the result of the Gmail OAuth round-trip, then clean the URL.
  useEffect(() => {
    if (params.get("connected")) {
      toast.success(t("gmailConnectSuccess"));
      router.replace(`/${locale}/reach/settings`);
    } else if (params.get("error")) {
      toast.error(t("gmailConnectError"));
      router.replace(`/${locale}/reach/settings`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function addSender() {
    if (!newSender.email.trim()) return;
    setAdding(true);
    try {
      await api("/api/reach/senders", {
        method: "POST",
        body: {
          email: newSender.email.trim(),
          label: newSender.label.trim() || null,
          daily_cap: newSender.daily_cap ? Number(newSender.daily_cap) : null,
        },
      });
      toast.success(t("senderAdded"));
      setNewSender({ email: "", label: "", daily_cap: "" });
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

  async function saveCap(id: string, daily_cap: number | null) {
    try {
      await api(`/api/reach/senders/${id}`, { method: "PATCH", body: { daily_cap } });
      setSenders((s) => s.map((x) => (x.id === id ? { ...x, daily_cap } : x)));
      toast.success(t("capSaved"));
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

  function connectGmail() {
    // Same-origin Next route handler (NOT the api() backend): starts the
    // org-owned Gmail OAuth and returns to this page with ?connected / ?error.
    window.location.href = "/api/auth/google?service=reach_gmail";
  }

  const sesSenders = senders.filter((s) => s.provider !== "gmail");
  const gmailSenders = senders.filter((s) => s.provider === "gmail");

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
          <p className="text-muted-foreground">{t("settingsSubtitle")}</p>
        </div>
        <Button asChild variant="outline" className="gap-2">
          <Link href={`/${locale}/reach`}>
            <ArrowRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
            {t("backToCampaigns")}
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="ses">
        <TabsList>
          <TabsTrigger value="ses" className="gap-2"><AtSign className="h-4 w-4" />{t("tabSes")}</TabsTrigger>
          <TabsTrigger value="gmail" className="gap-2"><Mail className="h-4 w-4" />{t("tabGmail")}</TabsTrigger>
        </TabsList>

        {/* ───────── SES ───────── */}
        <TabsContent value="ses" className="space-y-8">
          <section className="space-y-3 rounded-lg border p-5">
            <div>
              <h2 className="text-lg font-semibold">{t("sesTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("sesSubtitle")}</p>
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
                className="sm:max-w-[10rem]"
              />
              <Input
                type="number"
                min={1}
                placeholder={t("dailyCap")}
                value={newSender.daily_cap}
                onChange={(e) => setNewSender((s) => ({ ...s, daily_cap: e.target.value }))}
                className="sm:w-32"
              />
              <Button onClick={addSender} disabled={adding} className="gap-2">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t("add")}
              </Button>
            </div>

            {sesSenders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noSenders")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {sesSenders.map((s) => (
                  <SenderRow key={s.id} sender={s} onSaveCap={saveCap} onDelete={deleteSender} t={t} />
                ))}
              </ul>
            )}
          </section>

          {/* Region by language */}
          <section className="space-y-3 rounded-lg border p-5">
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
        </TabsContent>

        {/* ───────── Gmail ───────── */}
        <TabsContent value="gmail" className="space-y-4">
          <section className="space-y-3 rounded-lg border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{t("gmailTitle")}</h2>
                <p className="text-sm text-muted-foreground">{t("gmailSubtitle")}</p>
              </div>
              <Button onClick={connectGmail} className="gap-2">
                <Plus className="h-4 w-4" />
                {t("connectGmail")}
              </Button>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-status-warn/30 bg-status-warn-bg p-3 text-xs text-status-warn">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("gmailConnectNote")}</span>
            </div>

            {gmailSenders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noGmailInboxes")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {gmailSenders.map((s) => (
                  <SenderRow
                    key={s.id}
                    sender={s}
                    disabled={gmailStatus.get(s.id)?.disabled}
                    onReconnect={connectGmail}
                    onSaveCap={saveCap}
                    onDelete={deleteSender}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SenderRow({
  sender, disabled, onSaveCap, onDelete, onReconnect, t,
}: {
  sender: Sender;
  disabled?: boolean;
  onSaveCap: (id: string, cap: number | null) => void;
  onDelete: (id: string) => void;
  onReconnect?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [cap, setCap] = useState(sender.daily_cap != null ? String(sender.daily_cap) : "");
  const dirty = (sender.daily_cap != null ? String(sender.daily_cap) : "") !== cap;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <span className="min-w-0 truncate text-sm">
        {sender.email}
        {sender.label && <span className="text-muted-foreground"> · {sender.label}</span>}
        {disabled && <Badge variant="secondary" className="ms-2 text-status-late">{t("gmailInboxDisabled")}</Badge>}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {t("dailyCap")}
          <Input
            type="number"
            min={1}
            value={cap}
            placeholder={t("dailyCapHint")}
            onChange={(e) => setCap(e.target.value)}
            className="h-8 w-24"
          />
        </label>
        {dirty && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => onSaveCap(sender.id, cap ? Number(cap) : null)}
          >
            <Save className="h-3.5 w-3.5" />{t("saveCap")}
          </Button>
        )}
        {disabled && onReconnect && (
          <Button variant="outline" size="sm" className="h-8" onClick={onReconnect}>{t("reconnect")}</Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => onDelete(sender.id)} aria-label={t("delete")}>
          <Trash2 className="h-4 w-4 text-status-late" />
        </Button>
      </div>
    </li>
  );
}
