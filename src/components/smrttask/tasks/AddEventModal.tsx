"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, CalendarClock } from "lucide-react";
import { api } from "@/lib/api/client";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { eventReminderMoment } from "@/lib/workdays";
import { toast } from "sonner";

interface ExtractedEvent {
  title: string;
  date: string | null;
  time: string | null;
  description: string;
}

/**
 * Add-event dialog. Opened from a suggestion/task; pre-fills its fields with an
 * AI extraction of the event (title, date, time, description — the description
 * keeps the source deep-link verbatim). Saving writes the event to the
 * connected Google Calendar AND turns the task into an in-app event reminder
 * that resurfaces one working day before.
 */
export function AddEventModal({
  taskId,
  open,
  onClose,
  onDone,
  locale,
}: {
  taskId: string;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  locale: string;
}) {
  const t = useTranslations("events");
  const tCommon = useTranslations("common");
  const blocked = useWorkCalendar();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [description, setDescription] = useState("");

  // Pre-fill from the AI extraction each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api<ExtractedEvent>("/api/events/extract", { method: "POST", body: { task_id: taskId } })
      .then((data) => {
        if (cancelled) return;
        setTitle(data.title ?? "");
        setDate(data.date ?? "");
        setTime(data.time ?? "09:00");
        setDescription(data.description ?? "");
      })
      .catch(() => { /* leave the fields empty — the user can fill them in */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, taskId]);

  const weekday = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", { weekday: "long" })
    : "";

  async function handleSave() {
    if (!date || !time) {
      toast.error(t("needDateTime"));
      return;
    }
    setSaving(true);
    // Hide the reminder until one working day before the event (surface now when
    // it's too close). The backend uses this to snooze the task.
    const moment = eventReminderMoment(date, blocked);
    try {
      const { event } = await api<{ event: { htmlLink?: string } }>("/api/events", {
        method: "POST",
        body: {
          task_id: taskId,
          title,
          due_date: date,
          due_time: time,
          description,
          snoozed_until: moment?.iso ?? null,
        },
      });
      toast.success(t("saved"), event?.htmlLink
        ? { action: { label: t("openInCalendar"), onClick: () => window.open(event.htmlLink, "_blank") } }
        : undefined);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-md" dir={locale === "he" ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-start">
            <CalendarClock className="h-4 w-4" />
            {t("dialogTitle")}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t("extracting")}</p>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium">{t("titleLabel")}</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" disabled={saving} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium">{t("dateLabel")}</label>
                <DatePicker
                  value={date}
                  onChange={setDate}
                  min={new Date().toISOString().slice(0, 10)}
                  disabled={saving}
                />
                {weekday && <p className="mt-1 text-[11px] text-muted-foreground">{weekday}</p>}
              </div>
              <div>
                <label className="text-xs font-medium">{t("timeLabel")}</label>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={saving} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">{t("descriptionLabel")}</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-[90px] text-sm"
                dir="auto"
                disabled={saving}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={loading || saving || !date || !time} className="gap-1">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
