"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Save, Send, Users, Eye } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Campaign {
  id: string;
  name: string;
  channel: "whatsapp" | "email" | "both";
  status: string;
}
interface EmailDetail {
  subject: string | null;
  preview: string | null;
  sender: string | null;
  reply_to: string | null;
  html_body: string | null;
  language: string | null;
}
interface Sender {
  id: string;
  email: string;
  label: string | null;
}
interface Stats {
  sent: number;
  failed: number;
  opens: number;
  clicks: number;
}

const NONE = "__none__";

export function CampaignDetailClient({ campaignId }: { campaignId: string }) {
  const t = useTranslations("smrtReach");

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const [email, setEmail] = useState<EmailDetail>({
    subject: "", preview: "", sender: null, reply_to: "", html_body: "", language: "he",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ campaign, email }, { senders }, stats] = await Promise.all([
        api<{ campaign: Campaign; email: EmailDetail | null }>(`/api/reach/campaigns/${campaignId}`),
        api<{ senders: Sender[] }>("/api/reach/senders"),
        api<Stats>(`/api/reach/campaigns/${campaignId}/stats`),
      ]);
      setCampaign(campaign);
      setSenders(senders);
      setStats(stats);
      if (email) {
        setEmail({
          subject: email.subject ?? "",
          preview: email.preview ?? "",
          sender: email.sender ?? null,
          reply_to: email.reply_to ?? "",
          html_body: email.html_body ?? "",
          language: email.language ?? "he",
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveEmail() {
    setSaving(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}/email`, {
        method: "PUT",
        body: {
          subject: email.subject || null,
          preview: email.preview || null,
          sender: email.sender,
          reply_to: email.reply_to || null,
          html_body: email.html_body || null,
          language: email.language,
        },
      });
      toast.success(t("contentSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function previewRecipients() {
    try {
      const { total } = await api<{ total: number }>(`/api/reach/campaigns/${campaignId}/recipients`);
      setRecipientCount(total);
      toast.success(t("recipientsCount", { count: total }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function send() {
    if (!email.sender) {
      toast.error(t("selectSenderFirst"));
      return;
    }
    if (!window.confirm(t("sendConfirm"))) return;
    setSending(true);
    try {
      const r = await api<{ queued: number; sent: number; failed: number }>(
        `/api/reach/campaigns/${campaignId}/send`,
        { method: "POST" },
      );
      toast.success(t("sendStarted", { queued: r.queued, sent: r.sent }));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!campaign) {
    return <p className="text-muted-foreground">{t("campaignNotFound")}</p>;
  }

  const emailEnabled = campaign.channel === "email" || campaign.channel === "both";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{campaign.name}</h1>
          <Badge variant="secondary">{t(`status.${campaign.status}` as Parameters<typeof t>[0])}</Badge>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t("statSent")} value={stats.sent} />
          <Stat label={t("statFailed")} value={stats.failed} />
          <Stat label={t("statOpens")} value={stats.opens} />
          <Stat label={t("statClicks")} value={stats.clicks} />
        </div>
      )}

      {/* Email editor */}
      {emailEnabled ? (
        <div className="space-y-4 rounded-lg border p-5">
          <h2 className="text-lg font-semibold">{t("emailContent")}</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("sender")}</span>
              <Select
                value={email.sender ?? NONE}
                onValueChange={(v) => setEmail((e) => ({ ...e, sender: v === NONE ? null : v }))}
              >
                <SelectTrigger><SelectValue placeholder={t("selectSender")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("selectSender")}</SelectItem>
                  {senders.map((s) => (
                    <SelectItem key={s.id} value={s.email}>
                      {s.label ? `${s.label} · ${s.email}` : s.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("language")}</span>
              <Select value={email.language ?? "he"} onValueChange={(v) => setEmail((e) => ({ ...e, language: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="he">{t("langHe")}</SelectItem>
                  <SelectItem value="en">{t("langEn")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("subject")}</span>
            <Input value={email.subject ?? ""} onChange={(e) => setEmail((s) => ({ ...s, subject: e.target.value }))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("previewText")}</span>
            <Input value={email.preview ?? ""} onChange={(e) => setEmail((s) => ({ ...s, preview: e.target.value }))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("replyTo")}</span>
            <Input value={email.reply_to ?? ""} onChange={(e) => setEmail((s) => ({ ...s, reply_to: e.target.value }))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("htmlBody")}</span>
            <Textarea
              value={email.html_body ?? ""}
              onChange={(e) => setEmail((s) => ({ ...s, html_body: e.target.value }))}
              rows={10}
              dir="auto"
              placeholder={t("htmlBodyHint")}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={saveEmail} disabled={saving} variant="outline" className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("saveContent")}
            </Button>
            <Button onClick={previewRecipients} variant="outline" className="gap-2">
              <Eye className="h-4 w-4" />
              {t("previewRecipients")}
            </Button>
            {recipientCount !== null && (
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <Users className="h-4 w-4" />
                {t("recipientsCount", { count: recipientCount })}
              </span>
            )}
            <Button onClick={send} disabled={sending} className="gap-2 ms-auto">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t("sendNow")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-5 text-muted-foreground">{t("whatsappPending")}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
