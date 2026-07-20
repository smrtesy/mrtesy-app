"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api/client";
import type { DailyReportItem, DailyReportToday } from "@/types/daily-report";

/**
 * The daily self-report check-in. Opened from the pinned "fill daily report"
 * row at the top of the quick list. One tap per question; Save writes the day's
 * answers (server snapshots each option's label + score) and calls onSaved so
 * the pinned row disappears for the day.
 */
export function DailyReportCheckin({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("dailyReport");
  const [items, setItems] = useState<DailyReportItem[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({}); // item_id → option_id
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api<{ items: DailyReportItem[] }>("/api/daily-report/config"),
      api<DailyReportToday>("/api/daily-report/today"),
    ])
      .then(([cfg, today]) => {
        if (!alive) return;
        setItems(cfg.items ?? []);
        const pre: Record<string, string> = {};
        for (const [itemId, e] of Object.entries(today.entries ?? {})) {
          if (e.option_id) pre[itemId] = e.option_id;
        }
        setSelected(pre);
      })
      .catch(() => {
        if (alive) toast.error(t("loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, t]);

  const choose = (itemId: string, optionId: string) =>
    setSelected((prev) => ({ ...prev, [itemId]: optionId }));

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const answers = Object.entries(selected).map(([item_id, option_id]) => ({ item_id, option_id }));
      await api("/api/daily-report/today", { method: "PUT", body: { answers } });
      toast.success(t("checkinSaved"));
      onSaved();
      onClose();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [selected, t, onSaved, onClose]);

  const allAnswered = items.length > 0 && items.every((it) => it.id && selected[it.id]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle dir="auto">{t("checkinTitle")}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("loading")}
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" dir="auto">{t("noQuestions")}</p>
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <div key={item.id} className="space-y-1.5">
                <div className="text-sm font-medium" dir="auto">{item.label}</div>
                <div className="flex flex-wrap gap-1.5">
                  {item.options.map((opt) => {
                    const active = item.id ? selected[item.id] === opt.id : false;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        dir="auto"
                        onClick={() => item.id && opt.id && choose(item.id, opt.id)}
                        className={cn(
                          "rounded-full border px-3 py-1 text-sm transition-colors",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background hover:bg-accent",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("cancel")}</Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || loading || items.length === 0 || !allAnswered}
            className="gap-1"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("checkinSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
