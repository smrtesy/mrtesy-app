"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2 } from "lucide-react";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { addWorkdays } from "@/lib/workdays";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen `until` ISO string. The caller does the API call. */
  onConfirm: (untilIso: string) => Promise<void> | void;
  /** Optional title override; defaults to the snooze action label. */
  title?: string;
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
export function SnoozeDialog({ open, onClose, onConfirm, title }: Props) {
  const t = useTranslations("tasks.snooze");
  const tCommon = useTranslations("common");
  const blocked = useWorkCalendar();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [submitting, setSubmitting] = useState(false);

  // The snooze is never capped by the task's deadline — the user decides when
  // they want to see the task again, even past its due date. (A deadline cap
  // used to clamp overdue tasks to a moment already in the past, which woke
  // them immediately and made every snooze a no-op.)

  // Re-seed each time the dialog opens so reopening after a previous
  // snooze doesn't keep the stale date around.
  useEffect(() => {
    if (!open) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setDate(tomorrow.toISOString().slice(0, 10));
    setTime("09:00");
  }, [open]);

  // The three presets: tomorrow 09:00 · tomorrow 15:00 · +2 working days 09:00.
  // Clicking one APPLIES IMMEDIATELY (no confirm click).
  const presets: { key: string; date: Date; hour: number }[] = (() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [
      { key: "presetTomorrow", date: tomorrow, hour: 9 },
      { key: "presetTomorrowNoon", date: tomorrow, hour: 15 },
      { key: "presetTwoWorkdays", date: addWorkdays(new Date(), 2, blocked), hour: 9 },
    ];
  })();

  async function applyPreset(d: Date, hour: number) {
    const when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
    setSubmitting(true);
    try {
      await onConfirm(when.toISOString());
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

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
          {/* Quick presets — one tap snoozes and closes, no confirm needed. */}
          <div className="flex gap-2 flex-wrap">
            {presets.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant="outline"
                onClick={() => applyPreset(p.date, p.hour)}
                disabled={submitting}
              >
                {t(p.key)}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium">{t("dateLabel")}</label>
              <DatePicker
                value={date}
                onChange={setDate}
                min={new Date().toISOString().slice(0, 10)}
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

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!date || submitting} className="gap-1">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("confirmButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
