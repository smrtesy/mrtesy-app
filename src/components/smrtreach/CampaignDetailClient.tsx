"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Save, Send, Users, Eye, FlaskConical, Pause, Play, CalendarClock, Inbox, RefreshCw } from "lucide-react";

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
  scheduled_at: string | null;
  country_filter: string | null;
  test_batch_size: number | null;
}
interface EmailDetail {
  subject: string | null;
  preview: string | null;
  sender: string | null;
  reply_to: string | null;
  html_body: string | null;
  language: string | null;
  provider: string | null;
  priority: string | null;
  send_hours: { start?: number; end?: number } | null;
  exclude_shabbat: boolean | null;
  rate_limit: number | null;
  sto_enabled: boolean | null;
}
interface WhatsappDetail {
  bot_ref: string | null;
  template: string | null;
  template_lang: string | null;
  template_params: unknown[] | null;
  body_text: string | null;
  recipient_cap: number | null;
  send_hours: { start?: number; end?: number } | null;
  exclude_shabbat: boolean | null;
  tz_hour: number | null;
}
interface WaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  paramCount: number;
}
interface Sender { id: string; email: string; label: string | null }
interface Bot { id: string; name: string }
interface Stats {
  sent: number; failed: number; opens: number; clicks: number;
  bounces: number; complaints: number;
  open_rate: number; click_rate: number; bounce_rate: number;
  top_links: { url: string; count: number }[];
}
interface LogRow { contact_id: string | null; channel: string; status: string; error: string | null; sent_at: string | null }

const NONE = "__none__";

export function CampaignDetailClient({ campaignId }: { campaignId: string }) {
  const t = useTranslations("smrtReach");

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingWa, setSavingWa] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);

  const [schedule, setSchedule] = useState<{ scheduled_at: string; country_filter: string; test_batch_size: string }>({
    scheduled_at: "", country_filter: "all", test_batch_size: "",
  });
  const [gmailAccounts, setGmailAccounts] = useState<string[]>([]);
  const [email, setEmail] = useState<EmailDetail>({
    subject: "", preview: "", sender: null, reply_to: "", html_body: "", language: "he", provider: "ses",
    priority: "normal", send_hours: {}, exclude_shabbat: true, rate_limit: null, sto_enabled: false,
  });
  const [wa, setWa] = useState<WhatsappDetail>({
    bot_ref: null, template: "", template_lang: "he", template_params: [], body_text: "",
    recipient_cap: null, send_hours: {}, exclude_shabbat: true, tz_hour: null,
  });
  const [waMode, setWaMode] = useState<"template" | "text">("template");
  const [paramsText, setParamsText] = useState("");
  const [waTemplates, setWaTemplates] = useState<WaTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [showTemplateGuide, setShowTemplateGuide] = useState(false);

  const [testTo, setTestTo] = useState({ email: "", phone: "" });
  const [logRows, setLogRows] = useState<LogRow[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, { senders }, stats] = await Promise.all([
        api<{ campaign: Campaign; email: EmailDetail | null; whatsapp: WhatsappDetail | null }>(`/api/reach/campaigns/${campaignId}`),
        api<{ senders: Sender[] }>("/api/reach/senders"),
        api<Stats>(`/api/reach/campaigns/${campaignId}/stats`),
      ]);
      setCampaign(detail.campaign);
      setSenders(senders);
      setStats(stats);
      setSchedule({
        scheduled_at: detail.campaign.scheduled_at ? toLocalInput(detail.campaign.scheduled_at) : "",
        country_filter: detail.campaign.country_filter ?? "all",
        test_batch_size: detail.campaign.test_batch_size ? String(detail.campaign.test_batch_size) : "",
      });
      if (detail.email) {
        setEmail({
          subject: detail.email.subject ?? "", preview: detail.email.preview ?? "",
          sender: detail.email.sender ?? null, reply_to: detail.email.reply_to ?? "",
          html_body: detail.email.html_body ?? "", language: detail.email.language ?? "he",
          provider: detail.email.provider ?? "ses",
          priority: detail.email.priority ?? "normal", send_hours: detail.email.send_hours ?? {},
          exclude_shabbat: detail.email.exclude_shabbat ?? true, rate_limit: detail.email.rate_limit ?? null,
          sto_enabled: detail.email.sto_enabled ?? false,
        });
      }
      if (detail.whatsapp) {
        setWa({
          bot_ref: detail.whatsapp.bot_ref ?? null, template: detail.whatsapp.template ?? "",
          template_lang: detail.whatsapp.template_lang ?? "he", template_params: detail.whatsapp.template_params ?? [],
          body_text: detail.whatsapp.body_text ?? "", recipient_cap: detail.whatsapp.recipient_cap ?? null,
          send_hours: detail.whatsapp.send_hours ?? {}, exclude_shabbat: detail.whatsapp.exclude_shabbat ?? true,
          tz_hour: detail.whatsapp.tz_hour ?? null,
        });
        setWaMode(detail.whatsapp.template ? "template" : detail.whatsapp.body_text ? "text" : "template");
        setParamsText(detail.whatsapp.template_params?.length ? JSON.stringify(detail.whatsapp.template_params, null, 2) : "");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  // Bots are only needed for the WhatsApp editor; fetch lazily once we know the channel.
  useEffect(() => {
    if (!campaign) return;
    if (campaign.channel === "whatsapp" || campaign.channel === "both") {
      api<{ bots: Bot[] }>("/api/bot/bots").then(({ bots }) => setBots(bots)).catch(() => setBots([]));
    }
    if (campaign.channel === "email" || campaign.channel === "both") {
      api<{ accounts: { email: string }[] }>("/api/reach/gmail/accounts")
        .then(({ accounts }) => setGmailAccounts(accounts.map((a) => a.email)))
        .catch(() => setGmailAccounts([]));
    }
  }, [campaign]);

  const loadTemplates = useCallback(async (botRef: string) => {
    setLoadingTemplates(true);
    setTemplatesError(null);
    try {
      const { templates } = await api<{ templates: WaTemplate[] }>(`/api/bot/bots/${botRef}/wa/templates`);
      setWaTemplates(templates);
    } catch (e) {
      setWaTemplates([]);
      setTemplatesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  // Auto-load templates whenever a bot is selected.
  useEffect(() => {
    if (wa.bot_ref) loadTemplates(wa.bot_ref);
    else setWaTemplates([]);
  }, [wa.bot_ref, loadTemplates]);

  function sendHoursPayload(h: { start?: number; end?: number } | null): Record<string, number> {
    if (h && typeof h.start === "number" && typeof h.end === "number") return { start: h.start, end: h.end };
    return {};
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}`, {
        method: "PATCH",
        body: {
          scheduled_at: schedule.scheduled_at ? new Date(schedule.scheduled_at).toISOString() : null,
          country_filter: schedule.country_filter,
          test_batch_size: schedule.test_batch_size ? Number(schedule.test_batch_size) : null,
        },
      });
      toast.success(t("scheduleSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function saveEmail() {
    setSavingEmail(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}/email`, {
        method: "PUT",
        body: {
          subject: email.subject || null, preview: email.preview || null, sender: email.sender,
          reply_to: email.reply_to || null, html_body: email.html_body || null, language: email.language,
          provider: email.provider,
          priority: email.priority, send_hours: sendHoursPayload(email.send_hours),
          exclude_shabbat: email.exclude_shabbat, rate_limit: email.rate_limit || null,
          sto_enabled: email.sto_enabled,
        },
      });
      toast.success(t("contentSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEmail(false);
    }
  }

  async function saveWhatsapp() {
    let params: unknown[] = [];
    if (waMode === "template" && paramsText.trim()) {
      try {
        const parsed = JSON.parse(paramsText);
        if (!Array.isArray(parsed)) throw new Error();
        params = parsed;
      } catch {
        toast.error(t("templateParamsInvalid"));
        return;
      }
    }
    setSavingWa(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}/whatsapp`, {
        method: "PUT",
        body: {
          bot_ref: wa.bot_ref,
          template: waMode === "template" ? wa.template || null : null,
          template_lang: wa.template_lang,
          template_params: params,
          body_text: waMode === "text" ? wa.body_text || null : null,
          recipient_cap: wa.recipient_cap || null,
          send_hours: sendHoursPayload(wa.send_hours),
          exclude_shabbat: wa.exclude_shabbat,
          tz_hour: wa.tz_hour,
        },
      });
      toast.success(t("contentSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingWa(false);
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

  async function sendTest() {
    if (!testTo.email && !testTo.phone) { toast.error(t("testTargetRequired")); return; }
    setBusy(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}/test`, {
        method: "POST",
        body: { email: testTo.email || undefined, phone: testTo.phone || undefined },
      });
      toast.success(t("testSent"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function gmassTest() {
    if (!window.confirm(t("gmassConfirm"))) return;
    setBusy(true);
    try {
      const r = await api<{ sent: number; failed: number; resultsUrl: string }>(
        `/api/reach/campaigns/${campaignId}/inbox-test`, { method: "POST" },
      );
      toast.success(t("gmassSent", { sent: r.sent }));
      window.open(r.resultsUrl, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(mode: "now" | "scheduled") {
    const emailEnabled = campaign!.channel === "email" || campaign!.channel === "both";
    if (emailEnabled && email.provider !== "gmail" && !email.sender) { toast.error(t("selectSenderFirst")); return; }
    if (!window.confirm(mode === "now" ? t("sendNowConfirm") : t("scheduleSendConfirm"))) return;
    setSending(true);
    try {
      const body =
        mode === "scheduled"
          ? { mode, scheduled_at: schedule.scheduled_at ? new Date(schedule.scheduled_at).toISOString() : null }
          : { mode };
      const r = await api<{ queued: number; sent: number; paused: boolean }>(
        `/api/reach/campaigns/${campaignId}/send`, { method: "POST", body },
      );
      toast.success(
        r.paused ? t("testBatchSent", { sent: r.sent })
        : mode === "scheduled" ? t("scheduleSendStarted", { queued: r.queued })
        : t("sendStarted", { queued: r.queued, sent: r.sent }),
      );
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function pauseOrResume(action: "pause" | "resume") {
    setBusy(true);
    try {
      await api(`/api/reach/campaigns/${campaignId}/${action}`, { method: "POST" });
      toast.success(action === "pause" ? t("campaignPaused") : t("resumed"));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLog() {
    if (logRows) { setLogRows(null); return; }
    try {
      const { rows } = await api<{ rows: LogRow[] }>(`/api/reach/campaigns/${campaignId}/log?limit=200`);
      setLogRows(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (!campaign) return <p className="text-muted-foreground">{t("campaignNotFound")}</p>;

  const emailEnabled = campaign.channel === "email" || campaign.channel === "both";
  const waEnabled = campaign.channel === "whatsapp" || campaign.channel === "both";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{campaign.name}</h1>
          <Badge variant="secondary">{t(`status.${campaign.status}` as Parameters<typeof t>[0])}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status === "sending" && (
            <Button onClick={() => pauseOrResume("pause")} disabled={busy} variant="outline" size="sm" className="gap-1">
              <Pause className="h-4 w-4" />{t("pause")}
            </Button>
          )}
          {campaign.status === "paused" && (
            <Button onClick={() => pauseOrResume("resume")} disabled={busy} variant="outline" size="sm" className="gap-1">
              <Play className="h-4 w-4" />{t("resume")}
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t("statSent")} value={stats.sent} />
            <Stat label={t("statFailed")} value={stats.failed} />
            <Stat label={t("statOpens")} value={stats.opens} sub={`${stats.open_rate}%`} />
            <Stat label={t("statClicks")} value={stats.clicks} sub={`${stats.click_rate}%`} />
            <Stat label={t("statBounces")} value={stats.bounces} sub={`${stats.bounce_rate}%`} />
            <Stat label={t("statComplaints")} value={stats.complaints} />
          </div>
          {stats.top_links.length > 0 && (
            <div className="rounded-lg border p-3 text-sm">
              <div className="mb-2 font-medium">{t("topLinks")}</div>
              <ul className="space-y-1">
                {stats.top_links.map((l) => (
                  <li key={l.url} className="flex items-center justify-between gap-3">
                    <span className="truncate text-muted-foreground" dir="ltr">{l.url}</span>
                    <span className="shrink-0 font-medium">{l.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Button onClick={toggleLog} variant="ghost" size="sm">{logRows ? t("hideLog") : t("showLog")}</Button>
            {logRows && (
              <div className="mt-2 overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr><th className="p-2 text-start">{t("colChannel")}</th><th className="p-2 text-start">{t("colStatus")}</th><th className="p-2 text-start">{t("colSentAt")}</th><th className="p-2 text-start">{t("colError")}</th></tr>
                  </thead>
                  <tbody>
                    {logRows.length === 0 ? (
                      <tr><td colSpan={4} className="p-3 text-center text-muted-foreground">{t("noLog")}</td></tr>
                    ) : logRows.map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">{r.channel}</td>
                        <td className="p-2">{r.status}</td>
                        <td className="p-2" dir="ltr">{r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}</td>
                        <td className="p-2 text-destructive">{r.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedule + audience controls */}
      <div className="space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">{t("scheduleSection")}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("scheduleAt")}</span>
            <Input type="datetime-local" value={schedule.scheduled_at} onChange={(e) => setSchedule((s) => ({ ...s, scheduled_at: e.target.value }))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("countryFilter")}</span>
            <Select value={schedule.country_filter} onValueChange={(v) => setSchedule((s) => ({ ...s, country_filter: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["all", "israel", "us", "canada", "europe"].map((c) => (
                  <SelectItem key={c} value={c}>{t(`country.${c}` as Parameters<typeof t>[0])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{t("testBatchSize")}</span>
            <Input type="number" min={0} value={schedule.test_batch_size} placeholder={t("testBatchHint")} onChange={(e) => setSchedule((s) => ({ ...s, test_batch_size: e.target.value }))} />
          </label>
        </div>
        <Button onClick={saveSchedule} disabled={savingSchedule} variant="outline" size="sm" className="gap-2">
          {savingSchedule ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t("saveSchedule")}
        </Button>
      </div>

      {/* Email editor */}
      {emailEnabled && (
        <div className="space-y-4 rounded-lg border p-5">
          <h2 className="text-lg font-semibold">{t("emailContent")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("provider")}</span>
              <Select value={email.provider ?? "ses"} onValueChange={(v) => setEmail((e) => ({ ...e, provider: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ses">{t("providerSes")}</SelectItem>
                  <SelectItem value="gmail">{t("providerGmail")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("language")}</span>
              <Select value={email.language ?? "he"} onValueChange={(v) => setEmail((e) => ({ ...e, language: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="he">{t("langHe")}</SelectItem><SelectItem value="en">{t("langEn")}</SelectItem></SelectContent>
              </Select>
            </label>
          </div>
          {email.provider === "gmail" ? (
            <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
              {gmailAccounts.length > 0
                ? t("gmailAccountsConnected", { accounts: gmailAccounts.join(", ") })
                : t("gmailNoAccounts")}
            </p>
          ) : (
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("sender")}</span>
              <Select value={email.sender ?? NONE} onValueChange={(v) => setEmail((e) => ({ ...e, sender: v === NONE ? null : v }))}>
                <SelectTrigger><SelectValue placeholder={t("selectSender")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("selectSender")}</SelectItem>
                  {senders.map((s) => <SelectItem key={s.id} value={s.email}>{s.label ? `${s.label} · ${s.email}` : s.email}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          )}
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
            <Textarea value={email.html_body ?? ""} onChange={(e) => setEmail((s) => ({ ...s, html_body: e.target.value }))} rows={10} dir="auto" placeholder={t("htmlBodyHint")} />
          </label>

          {/* Send controls */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 border-t pt-4">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("priority")}</span>
              <Select value={email.priority ?? "normal"} onValueChange={(v) => setEmail((e) => ({ ...e, priority: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["low", "normal", "high"].map((p) => <SelectItem key={p} value={p}>{t(`priorityOpt.${p}` as Parameters<typeof t>[0])}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <HourRange t={t} value={email.send_hours ?? {}} onChange={(h) => setEmail((e) => ({ ...e, send_hours: h }))} />
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("rateLimit")}</span>
              <Input type="number" min={0} value={email.rate_limit ?? ""} placeholder={t("rateLimitHint")} onChange={(e) => setEmail((s) => ({ ...s, rate_limit: e.target.value ? Number(e.target.value) : null }))} />
            </label>
            <div className="flex flex-col justify-end gap-2">
              <Toggle label={t("excludeShabbat")} checked={!!email.exclude_shabbat} onChange={(v) => setEmail((e) => ({ ...e, exclude_shabbat: v }))} />
              <Toggle label={t("sto")} checked={!!email.sto_enabled} onChange={(v) => setEmail((e) => ({ ...e, sto_enabled: v }))} />
            </div>
          </div>

          <Button onClick={saveEmail} disabled={savingEmail} variant="outline" className="gap-2">
            {savingEmail ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t("saveContent")}
          </Button>
        </div>
      )}

      {/* WhatsApp editor */}
      {waEnabled && (
        <div className="space-y-4 rounded-lg border p-5">
          <h2 className="text-lg font-semibold">{t("whatsappContent")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("bot")}</span>
              <Select value={wa.bot_ref ?? NONE} onValueChange={(v) => setWa((w) => ({ ...w, bot_ref: v === NONE ? null : v }))}>
                <SelectTrigger><SelectValue placeholder={t("selectBot")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("selectBot")}</SelectItem>
                  {bots.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("waMode")}</span>
              <Select value={waMode} onValueChange={(v) => setWaMode(v as "template" | "text")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="template">{t("waModeTemplate")}</SelectItem><SelectItem value="text">{t("waModeText")}</SelectItem></SelectContent>
              </Select>
            </label>
          </div>

          {waMode === "template" ? (
            <>
              {!wa.bot_ref ? (
                <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{t("selectBotForTemplates")}</p>
              ) : (
                <>
                  {/* Approved templates pulled live from Meta. */}
                  {(() => {
                    const approved = waTemplates.filter((x) => x.status === "APPROVED");
                    const selected = waTemplates.find((x) => x.name === wa.template && x.language === wa.template_lang);
                    return (
                      <>
                        <div className="flex items-end gap-2">
                          <label className="grid flex-1 gap-1 text-sm">
                            <span className="text-muted-foreground">{t("templateApproved")}</span>
                            <Select
                              value={selected ? `${selected.name}|||${selected.language}` : NONE}
                              onValueChange={(v) => {
                                if (v === NONE) return;
                                const [name, language] = v.split("|||");
                                setWa((w) => ({ ...w, template: name, template_lang: language }));
                              }}
                            >
                              <SelectTrigger><SelectValue placeholder={t("selectTemplate")} /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE}>{t("selectTemplate")}</SelectItem>
                                {approved.map((x) => (
                                  <SelectItem key={`${x.name}|||${x.language}`} value={`${x.name}|||${x.language}`}>
                                    {x.name} · {x.language} · {x.category}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </label>
                          <Button type="button" onClick={() => loadTemplates(wa.bot_ref!)} disabled={loadingTemplates} variant="outline" size="icon" title={t("refreshTemplates")}>
                            {loadingTemplates ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          </Button>
                        </div>
                        {templatesError && <p className="text-xs text-destructive">{t("templatesError")}: {templatesError}</p>}
                        {!templatesError && approved.length === 0 && !loadingTemplates && (
                          <p className="text-xs text-muted-foreground">{t("noTemplatesFound")}</p>
                        )}
                        {selected && (
                          <div className="rounded-md bg-muted/40 p-2 text-xs">
                            <div className="whitespace-pre-wrap text-muted-foreground" dir="auto">{selected.body}</div>
                            {selected.paramCount > 0 && (
                              <div className="mt-1 font-medium">{t("templateParamsNeeded", { count: selected.paramCount })}</div>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <label className="grid gap-1 text-sm">
                    <span className="text-muted-foreground">{t("templateParams")}</span>
                    <Textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} rows={4} dir="ltr" placeholder={t("templateParamsHint")} />
                  </label>
                </>
              )}
              {/* How to add a new template (collapsible guidance). */}
              <div className="rounded-md border">
                <button type="button" onClick={() => setShowTemplateGuide((s) => !s)} className="flex w-full items-center justify-between p-2 text-sm font-medium">
                  <span>{t("templateGuideTitle")}</span>
                  <span className="text-muted-foreground">{showTemplateGuide ? "−" : "+"}</span>
                </button>
                {showTemplateGuide && (
                  <div className="space-y-2 border-t p-3 text-xs text-muted-foreground">
                    <ol className="list-decimal space-y-1 ps-4">
                      <li>{t("templateGuide1")}</li>
                      <li>{t("templateGuide2")}</li>
                      <li>{t("templateGuide3")}</li>
                      <li>{t("templateGuide4")}</li>
                      <li>{t("templateGuide5")}</li>
                    </ol>
                    <a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noopener noreferrer" className="inline-block font-medium text-foreground underline">
                      {t("openWaManager")}
                    </a>
                  </div>
                )}
              </div>
            </>
          ) : (
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("bodyText")}</span>
              <Textarea value={wa.body_text ?? ""} onChange={(e) => setWa((w) => ({ ...w, body_text: e.target.value }))} rows={5} dir="auto" />
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 border-t pt-4">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("recipientCap")}</span>
              <Input type="number" min={0} value={wa.recipient_cap ?? ""} onChange={(e) => setWa((w) => ({ ...w, recipient_cap: e.target.value ? Number(e.target.value) : null }))} />
            </label>
            <HourRange t={t} value={wa.send_hours ?? {}} onChange={(h) => setWa((w) => ({ ...w, send_hours: h }))} />
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("tzHour")}</span>
              <Input type="number" min={0} max={23} value={wa.tz_hour ?? ""} placeholder={t("tzHourHint")}
                onChange={(e) => setWa((w) => ({ ...w, tz_hour: e.target.value === "" ? null : Number(e.target.value) }))} />
            </label>
            <div className="flex items-end">
              <Toggle label={t("excludeShabbat")} checked={!!wa.exclude_shabbat} onChange={(v) => setWa((w) => ({ ...w, exclude_shabbat: v }))} />
            </div>
          </div>

          <Button onClick={saveWhatsapp} disabled={savingWa} variant="outline" className="gap-2">
            {savingWa ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t("saveContent")}
          </Button>
        </div>
      )}

      {/* Test send + actions */}
      <div className="space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">{t("testSendTitle")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {emailEnabled && <Input value={testTo.email} placeholder={t("testEmailPlaceholder")} onChange={(e) => setTestTo((s) => ({ ...s, email: e.target.value }))} />}
          {waEnabled && <Input value={testTo.phone} placeholder={t("testPhonePlaceholder")} dir="ltr" onChange={(e) => setTestTo((s) => ({ ...s, phone: e.target.value }))} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={sendTest} disabled={busy} variant="outline" className="gap-2"><FlaskConical className="h-4 w-4" />{t("sendTest")}</Button>
          {emailEnabled && (
            <Button onClick={gmassTest} disabled={busy} variant="outline" className="gap-2"><Inbox className="h-4 w-4" />{t("gmassTest")}</Button>
          )}
          <Button onClick={previewRecipients} variant="outline" className="gap-2"><Eye className="h-4 w-4" />{t("previewRecipients")}</Button>
          {recipientCount !== null && (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><Users className="h-4 w-4" />{t("recipientsCount", { count: recipientCount })}</span>
          )}
          {schedule.scheduled_at && (
            <Button onClick={() => send("scheduled")} disabled={sending} variant="outline" className="gap-2 ms-auto">
              <CalendarClock className="h-4 w-4" />{t("scheduleSend")}
            </Button>
          )}
          <Button onClick={() => send("now")} disabled={sending} className={`gap-2 ${schedule.scheduled_at ? "" : "ms-auto"}`}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t("sendNow")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("sendNowNote")}</p>
      </div>
    </div>
  );
}

/** datetime-local needs a "YYYY-MM-DDTHH:mm" string in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}{sub ? ` · ${sub}` : ""}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      <span>{label}</span>
    </label>
  );
}

function HourRange({
  t, value, onChange,
}: {
  t: ReturnType<typeof useTranslations>;
  value: { start?: number; end?: number };
  onChange: (h: { start?: number; end?: number }) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{t("sendHours")}</span>
      <div className="flex items-center gap-1">
        <Input type="number" min={0} max={23} className="w-16" placeholder={t("sendHoursStart")}
          value={value.start ?? ""} onChange={(e) => onChange({ ...value, start: e.target.value === "" ? undefined : Number(e.target.value) })} />
        <span className="text-muted-foreground">–</span>
        <Input type="number" min={0} max={23} className="w-16" placeholder={t("sendHoursEnd")}
          value={value.end ?? ""} onChange={(e) => onChange({ ...value, end: e.target.value === "" ? undefined : Number(e.target.value) })} />
      </div>
    </label>
  );
}
