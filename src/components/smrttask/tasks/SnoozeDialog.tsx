"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen `until` ISO string. The caller does the API call. */
  onConfirm: (untilIso: string) => Promise<void> | void;
  /** Optional title override; defaults to the snooze action label. */
  title?: string;
  /**
   * The task's deadline (YYYY-MM-DD). Snoozing PAST the deadline would hide
   * the task until it's already late, so dates after it are blocked and the
   * presets that would land past it are disabled.
   */
  maxDate?: string | null;
}

/**
 * Date + (optional) time picker for the snooze action. Defaults to
 * tomorrow at 09:00 — the same value the backend would pick if no body
 * is sent — so the most common case stays one-click.
 *
 * The "Time" field is optional in the sense that the user can leave it
 * at the default; we don't surface a separate toggle because every snooze
 * needs *some* concrete moment to resurface, and shipping without a time
 * input would force the same hardcoded 09:00 the user is trying to escape.
 */
export function SnoozeDialog({ open, onClose, onConfirm, title, maxDate }: Props) {
  const t = useTranslations("tasks.snooze");
  const tCommon = useTranslations("common");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [submitting, setSubmitting] = useState(false);

  // Re-seed each time the dialog opens so reopening after a previous
  // snooze doesn't keep the stale date around.
  useEffect(() => {
    if (!open) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    let seed = tomorrow.toISOString().slice(0, 10);
    if (maxDate && seed > maxDate) seed = maxDate;
    setDate(seed);
    setTime("09:00");
  }, [open, maxDate]);

  function presetDate(daysAhead: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString().slice(0, 10);
  }

  function presetBlocked(daysAhead: number): boolean {
    return !!maxDate && presetDate(daysAhead) > maxDate;
  }

  function setPreset(daysAhead: number, hour: number) {
    setDate(presetDate(daysAhead));
    setTime(`${String(hour).padStart(2, "0")}:00`);
  }

  const pastDeadline = !!maxDate && !!date && date > maxDate;

  async function handleConfirm() {
    if (!date) return;
    // Construct the Date in LOCAL time. `new Date("2025-05-22")` would
    // parse as UTC midnight (per ECMAScript spec) and then setHours would
    // be offset by the user's timezone — e.g. Israel UTC+3 would snooze
    // 3 hours earlier than the user picked. Build from numeric parts so
    // every field is interpreted in the browser's local zone.
    const [yy, mm, dd] = date.split("-").map((s) => parseInt(s, 10));
    const [h, m] = (time || "09:00").split(":").map((s) => parseInt(s, 10));
    const d = new Date(
      yy,
      (mm || 1) - 1,
      dd || 1,
      Number.isFinite(h) ? h : 9,
      Number.isFinite(m) ? m : 0,
      0,
      0,
    );
    if (d.getTime() <= Date.now()) {
      // Auto-shift to tomorrow at the same time if user picked a past moment.
      d.setDate(d.getDate() + 1);
    }
    // The auto-shift must not sneak past the deadline guard.
    if (maxDate && d.toISOString().slice(0, 10) > maxDate) {
      toast.error(t("pastDeadline", { date: maxDate }));
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(d.toISOString());
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-start">{title ?? t("title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Quick presets — cover the 90% of cases without typing. */}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => setPreset(1, 9)} disabled={submitting || presetBlocked(1)}>
              {t("presetTomorrow")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPreset(1, 18)} disabled={submitting || presetBlocked(1)}>
              {t("presetTomorrowEvening")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPreset(7, 9)} disabled={submitting || presetBlocked(7)}>
              {t("presetNextWeek")}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium">{t("dateLabel")}</label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                max={maxDate ?? undefined}
                disabled={submitting}
              />
            </div>
            <div>
              <label className="text-xs font-medium">{t("timeLabel")}</label>
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
        </div>

        {pastDeadline && (
          <p className="text-xs text-status-late" dir="auto">{t("pastDeadline", { date: maxDate ?? "" })}</p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!date || submitting || pastDeadline} className="gap-1">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("confirmButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
