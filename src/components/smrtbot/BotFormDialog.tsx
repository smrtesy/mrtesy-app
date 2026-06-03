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
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || !slug.trim()) return;
    setSaving(true);
    try {
      await api("/api/bot/bots", { method: "POST", body: { name, slug } });
      toast.success(t("created"));
      setOpen(false);
      setName("");
      setSlug("");
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
