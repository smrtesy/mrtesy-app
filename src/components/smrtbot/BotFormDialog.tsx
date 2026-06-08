"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";

/** Create a new bot. Backend gates this to org owner/admin (requireRole). */
export function BotFormDialog({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations("smrtBot");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [transport, setTransport] = useState<"meta" | "baileys">("meta");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || !slug.trim()) return;
    setSaving(true);
    try {
      await api("/api/bot/bots", { method: "POST", body: { name, slug, transport } });
      toast.success(t("created"));
      setOpen(false);
      setName("");
      setSlug("");
      setTransport("meta");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="me-2 h-4 w-4" />
          {t("addBot")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addBot")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("fieldName")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("fieldSlug")}</label>
            <Input
              dir="ltr"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="rl"
            />
            <p className="text-xs text-muted-foreground">{t("slugHint")}</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("transportLabel")}</label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value === "baileys" ? "baileys" : "meta")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="meta">{t("transportMeta")}</option>
              <option value="baileys">{t("transportBaileys")}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {transport === "baileys" ? t("transportBaileysHint") : t("transportMetaHint")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving || !name.trim() || !slug.trim()}>
            {saving ? "…" : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
