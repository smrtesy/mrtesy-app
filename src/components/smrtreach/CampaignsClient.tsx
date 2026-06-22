"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { Loader2, Mail, MessageCircle, Layers, ChevronLeft, BarChart3, Settings, Trash2 } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Channel = "whatsapp" | "email" | "both";

interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  status: string;
}

interface Named {
  id: string;
  name: string;
}

interface DeliverabilityRow {
  id: string;
  name: string;
  channel: Channel;
  sent: number;
  failed: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
}

const ALL_CONTACTS = "all:";

export function CampaignsClient() {
  const t = useTranslations("smrtReach");
  const locale = useLocale();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [deliverability, setDeliverability] = useState<DeliverabilityRow[] | null>(null);
  const [loadingDeliv, setLoadingDeliv] = useState(false);
  const [tags, setTags] = useState<Named[]>([]);
  const [segments, setSegments] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // audienceKey is "<kind>:<id?>" — kind ∈ all|tag|segment.
  const [form, setForm] = useState<{ name: string; channel: Channel; audienceKey: string }>({
    name: "",
    channel: "email",
    audienceKey: ALL_CONTACTS,
  });

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { campaigns } = await api<{ campaigns: Campaign[] }>("/api/reach/campaigns");
      setCampaigns(campaigns);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudiences = useCallback(async () => {
    // Audiences come from smrtCRM (tags / segments). If smrtCRM isn't
    // enabled for this org, fall back silently to "all contacts".
    try {
      const [{ tags }, { segments }] = await Promise.all([
        api<{ tags: Named[] }>("/api/crm/tags"),
        api<{ segments: Named[] }>("/api/crm/segments"),
      ]);
      setTags(tags ?? []);
      setSegments(segments ?? []);
    } catch {
      setTags([]); setSegments([]);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadAudiences();
  }, [loadCampaigns, loadAudiences]);

  function openCreate(channel: Channel) {
    setForm({ name: "", channel, audienceKey: ALL_CONTACTS });
    setCreateOpen(true);
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const [kind, id] = form.audienceKey.split(":");
      const audience = id ? { kind, id } : { kind: "all" };
      await api("/api/reach/campaigns", {
        method: "POST",
        body: { name: form.name.trim(), channel: form.channel, audience },
      });
      toast.success(t("campaignCreated"));
      setForm({ name: "", channel: "email", audienceKey: ALL_CONTACTS });
      setCreateOpen(false);
      loadCampaigns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c: Campaign) {
    if (!window.confirm(t("deleteCampaignConfirm"))) return;
    setDeletingId(c.id);
    try {
      await api(`/api/reach/campaigns/${c.id}`, { method: "DELETE" });
      toast.success(t("campaignDeleted"));
      setCampaigns((prev) => prev.filter((x) => x.id !== c.id));
      if (deliverability) setDeliverability((prev) => prev?.filter((x) => x.id !== c.id) ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  }

  async function toggleDeliverability() {
    if (deliverability) { setDeliverability(null); return; }
    setLoadingDeliv(true);
    try {
      const { rows } = await api<{ rows: DeliverabilityRow[] }>("/api/reach/deliverability");
      setDeliverability(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDeliv(false);
    }
  }

  function ChannelIcon({ channel }: { channel: Channel }) {
    if (channel === "email") return <Mail className="h-4 w-4" />;
    if (channel === "whatsapp") return <MessageCircle className="h-4 w-4" />;
    return <Layers className="h-4 w-4" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button asChild variant="ghost" className="gap-2 me-auto">
          <Link href={`/${locale}/reach/settings`}>
            <Settings className="h-4 w-4" />
            {t("settingsLink")}
          </Link>
        </Button>
        <Button onClick={toggleDeliverability} variant="outline" className="gap-2" disabled={loadingDeliv}>
          {loadingDeliv ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
          {deliverability ? t("hideDeliverability") : t("deliverability")}
        </Button>
        <Button onClick={() => openCreate("email")} variant="outline" className="gap-2">
          <Mail className="h-4 w-4" />
          {t("createEmailCampaign")}
        </Button>
        <Button onClick={() => openCreate("whatsapp")} className="gap-2">
          <MessageCircle className="h-4 w-4" />
          {t("createWhatsappCampaign")}
        </Button>
      </div>

      {deliverability && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("colName")}</th>
                <th className="p-2 text-start">{t("statSent")}</th>
                <th className="p-2 text-start">{t("statFailed")}</th>
                <th className="p-2 text-start">{t("openRate")}</th>
                <th className="p-2 text-start">{t("clickRate")}</th>
                <th className="p-2 text-start">{t("bounceRate")}</th>
              </tr>
            </thead>
            <tbody>
              {deliverability.length === 0 ? (
                <tr><td colSpan={6} className="p-3 text-center text-muted-foreground">{t("noCampaigns")}</td></tr>
              ) : deliverability.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="p-2 font-medium">{d.name}</td>
                  <td className="p-2">{d.sent}</td>
                  <td className="p-2">{d.failed}</td>
                  <td className="p-2">{d.open_rate}%</td>
                  <td className="p-2">{d.click_rate}%</td>
                  <td className="p-2">{d.bounce_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          {t("noCampaigns")}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {campaigns.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent">
              <Link
                href={`/${locale}/reach/campaigns/${c.id}`}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <span className="text-muted-foreground">
                  <ChannelIcon channel={c.channel} />
                </span>
                <span className="truncate font-medium">{c.name}</span>
              </Link>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{t(`status.${c.status}` as Parameters<typeof t>[0])}</Badge>
                <Button asChild variant="ghost" size="sm" className="gap-1">
                  <Link href={`/${locale}/reach/campaigns/${c.id}`}>
                    <BarChart3 className="h-4 w-4" />
                    <span className="hidden sm:inline">{t("statistics")}</span>
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(c)}
                  disabled={deletingId === c.id}
                  aria-label={t("deleteCampaign")}
                  title={t("deleteCampaign")}
                >
                  {deletingId === c.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 text-status-late" />
                  )}
                </Button>
                <ChevronLeft className="h-4 w-4 text-muted-foreground rtl:rotate-0 ltr:rotate-180" />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.channel === "whatsapp" ? t("createWhatsappCampaign") : t("createEmailCampaign")}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Input
              placeholder={t("campaignName")}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">{t("audience")}</label>
              <Select
                value={form.audienceKey}
                onValueChange={(v) => setForm((f) => ({ ...f, audienceKey: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CONTACTS}>{t("audienceAll")}</SelectItem>
                  {tags.map((tag) => (
                    <SelectItem key={`tag:${tag.id}`} value={`tag:${tag.id}`}>{t("audienceTag")}: {tag.name}</SelectItem>
                  ))}
                  {segments.map((s) => (
                    <SelectItem key={`segment:${s.id}`} value={`segment:${s.id}`}>{t("audienceSegment")}: {s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
