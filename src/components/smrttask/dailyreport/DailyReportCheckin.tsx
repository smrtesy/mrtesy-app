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
import { dayLabel } from "@/lib/smrttask/dailyreport-dates";
import type { DailyReportCheckin as CheckinData } from "@/types/daily-report";

/** selection key = `${entry_date}:${item_id}` → chosen option_id. */
type SelKey = string;

/**
 * The daily self-report check-in for one fill-day. Two sections: the top closes
 * YESTERDAY ("סיום יום …"), the bottom opens the fill-day ("תחילת יום …"), each
 * headed by its Hebrew + Gregorian date. Save writes each answer with its own
 * entry_date (server snapshots label + score) and calls onSaved so the pinned
 * row for this fill-day disappears.
 */
export function DailyReportCheckin({
  open,
  fillDate,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The fill-day this check-in covers (YYYY-MM-DD). */
  fillDate: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("dailyReport");
  const [data, setData] = useState<CheckinData | null>(null);
  const [selected, setSelected] = useState<Record<SelKey, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !fillDate) return;
    let alive = true;
    setLoading(true);
    api<CheckinData>(`/api/daily-report/checkin?fillDate=${fillDate}`)
      .then((res) => {
        if (!alive) return;
        setData(res);
        const pre: Record<SelKey, string> = {};
        for (const sec of res.sections) {
          for (const it of sec.items) {
            if (it.selected_option_id) pre[`${sec.entry_date}:${it.id}`] = it.selected_option_id;
          }
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
  }, [open, fillDate, t]);

  const choose = (entryDate: string, itemId: string, optionId: string) =>
    setSelected((prev) => ({ ...prev, [`${entryDate}:${itemId}`]: optionId }));

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    try {
      const answers = data.sections.flatMap((sec) =>
        sec.items
          .map((it) => {
            const optionId = selected[`${sec.entry_date}:${it.id}`];
            return optionId ? { item_id: it.id, option_id: optionId, entry_date: sec.entry_date } : null;
          })
          .filter((a): a is { item_id: string; option_id: string; entry_date: string } => a != null),
      );
      await api("/api/daily-report/checkin", { method: "PUT", body: { answers } });
      toast.success(t("checkinSaved"));
      onSaved();
      onClose();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [data, selected, t, onSaved, onClose]);

  const sections = data?.sections ?? [];
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const allAnswered =
    totalItems > 0 &&
    sections.every((s) => s.items.every((it) => selected[`${s.entry_date}:${it.id}`]));

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
        ) : totalItems === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" dir="auto">{t("noQuestions")}</p>
        ) : (
          <div className="space-y-5">
            {sections.map((sec) => (
              <div key={`${sec.segment}:${sec.entry_date}`} className="space-y-3">
                <div className="border-b pb-1 text-xs font-semibold text-muted-foreground" dir="auto">
                  {sec.segment === "end" ? t("segmentEnd") : t("segmentStart")} · {dayLabel(sec.entry_date)}
                </div>
                {sec.items.map((item) => (
                  <div key={item.id} className="space-y-1.5">
                    <div className="text-sm font-medium" dir="auto">{item.label}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {item.options.map((opt) => {
                        const active = selected[`${sec.entry_date}:${item.id}`] === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            dir="auto"
                            onClick={() => choose(sec.entry_date, item.id, opt.id)}
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
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("cancel")}</Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || loading || totalItems === 0 || !allAnswered}
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
