"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Loader2, Mail, MessageCircle, Layers } from "lucide-react";

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

interface Tag {
  id: string;
  name: string;
}

const ALL_CONTACTS = "__all__";

export function CampaignsClient() {
  const t = useTranslations("smrtReach");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{ name: string; channel: Channel; audienceTag: string }>({
    name: "",
    channel: "email",
    audienceTag: ALL_CONTACTS,
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

  const loadTags = useCallback(async () => {
    try {
      // Audiences come from smrtCRM tags (smrtReach reads CRM audiences).
      const { tags } = await api<{ tags: Tag[] }>("/api/crm/tags");
      setTags(tags);
    } catch {
      // smrtCRM may not be enabled for this org — audiences fall back to "all".
      setTags([]);
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadTags();
  }, [loadCampaigns, loadTags]);

  async function handleCreate() {
    if (!form.name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const audience =
        form.audienceTag === ALL_CONTACTS
          ? { kind: "all" }
          : { kind: "tag", id: form.audienceTag };
      await api("/api/reach/campaigns", {
        method: "POST",
        body: { name: form.name.trim(), channel: form.channel, audience },
      });
      toast.success(t("campaignCreated"));
      setForm({ name: "", channel: "email", audienceTag: ALL_CONTACTS });
      setCreateOpen(false);
      loadCampaigns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function ChannelIcon({ channel }: { channel: Channel }) {
    if (channel === "email") return <Mail className="h-4 w-4" />;
    if (channel === "whatsapp") return <MessageCircle className="h-4 w-4" />;
    return <Layers className="h-4 w-4" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          {t("newCampaign")}
        </Button>
      </div>

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
            <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-muted-foreground">
                  <ChannelIcon channel={c.channel} />
                </span>
                <span className="truncate font-medium">{c.name}</span>
              </div>
              <Badge variant="secondary">{t(`status.${c.status}` as Parameters<typeof t>[0])}</Badge>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newCampaign")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Input
              placeholder={t("campaignName")}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">{t("channel")}</label>
              <Select
                value={form.channel}
                onValueChange={(v) => setForm((f) => ({ ...f, channel: v as Channel }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">{t("channelEmail")}</SelectItem>
                  <SelectItem value="whatsapp">{t("channelWhatsapp")}</SelectItem>
                  <SelectItem value="both">{t("channelBoth")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">{t("audience")}</label>
              <Select
                value={form.audienceTag}
                onValueChange={(v) => setForm((f) => ({ ...f, audienceTag: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CONTACTS}>{t("audienceAll")}</SelectItem>
                  {tags.map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>
                      {tag.name}
                    </SelectItem>
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
