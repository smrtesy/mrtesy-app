"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Check } from "lucide-react";
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
 * headed by its Hebrew + Gregorian date.
 *
 * Each answer is saved AUTOMATICALLY the moment it is chosen — there is no
 * save-all button and no completeness gate. A partly-filled day is never lost:
 * every answer persists on its own, the pinned "fill your report" row stays up
 * until the day is fully answered (server /pending), and it clears itself the
 * moment the last question is answered. Re-opening the day (today or a past one)
 * pre-selects the answers already on record; re-choosing overwrites just that
 * one answer. onSaved fires after every successful write so the pinned row and
 * report tallies refresh live.
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
  const [failed, setFailed] = useState(false);
  /** Keys with an in-flight auto-save (shows a per-question spinner). */
  const [savingKeys, setSavingKeys] = useState<Record<SelKey, boolean>>({});
  /** What is actually persisted on the server — the baseline for detecting a
   *  real change (skip re-saving an unchanged answer) and for reverting on a
   *  failed write. A ref so the choose() callback never reads a stale value. */
  const savedRef = useRef<Record<SelKey, string>>({});
  /** The most recent option the user picked per key. Guards against a slow
   *  save landing after a newer choice for the same question — the stale
   *  response must not overwrite the newer intent (state or DB baseline). */
  const latestRef = useRef<Record<SelKey, string>>({});

  useEffect(() => {
    if (!open || !fillDate) return;
    let alive = true;
    setLoading(true);
    setFailed(false);
    // Drop the previous day's payload up front: this dialog stays mounted, so a
    // failed load would otherwise leave the PREVIOUS day's sections + selections
    // on screen and a save would post that day's entry_dates.
    setData(null);
    setSelected({});
    setSavingKeys({});
    savedRef.current = {};
    latestRef.current = {};
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
        savedRef.current = { ...pre };
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        toast.error(t("loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, fillDate, t]);

  /** Choose an option → optimistic select + auto-save that one answer. */
  const choose = useCallback(
    (entryDate: string, itemId: string, optionId: string) => {
      const key: SelKey = `${entryDate}:${itemId}`;
      // Already the persisted answer → nothing to write. (Re-posting it would
      // re-snapshot the option's current label + score onto a past entry_date,
      // rewriting the averages of any report that already covered that day.)
      if (savedRef.current[key] === optionId) return;

      latestRef.current[key] = optionId;
      setSelected((cur) => ({ ...cur, [key]: optionId }));
      setSavingKeys((s) => ({ ...s, [key]: true }));
      void (async () => {
        try {
          await api("/api/daily-report/checkin", {
            method: "PUT",
            body: { answers: [{ item_id: itemId, option_id: optionId, entry_date: entryDate }] },
          });
          // A newer pick for this question already superseded us — leave its
          // optimistic state and pending save alone.
          if (latestRef.current[key] !== optionId) return;
          savedRef.current[key] = optionId;
          onSaved(); // refresh the pinned row / report tallies live
        } catch {
          if (latestRef.current[key] !== optionId) return; // superseded — don't clobber
          // Revert the optimistic choice to whatever was last persisted.
          setSelected((cur) => {
            const next = { ...cur };
            const restore = savedRef.current[key];
            if (restore === undefined) delete next[key];
            else next[key] = restore;
            return next;
          });
          toast.error(t("saveError"));
        } finally {
          // Only the latest in-flight save owns the spinner for this key.
          if (latestRef.current[key] === optionId) {
            setSavingKeys((s) => {
              const next = { ...s };
              delete next[key];
              return next;
            });
          }
        }
      })();
    },
    [onSaved, t],
  );

  const sections = data?.sections ?? [];
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  const answeredCount = sections.reduce(
    (n, s) => n + s.items.filter((it) => selected[`${s.entry_date}:${it.id}`]).length,
    0,
  );
  const allDone = totalItems > 0 && answeredCount === totalItems;

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
        ) : failed ? (
          // A failed load must not read as "you never configured questions".
          <p className="py-6 text-center text-sm text-muted-foreground" dir="auto">{t("loadError")}</p>
        ) : totalItems === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" dir="auto">{t("noQuestions")}</p>
        ) : (
          <div className="space-y-5">
            {sections.map((sec) => (
              <div key={`${sec.segment}:${sec.entry_date}`} className="space-y-3">
                <div className="border-b pb-1 text-xs font-semibold text-muted-foreground" dir="auto">
                  {sec.segment === "end" ? t("segmentEnd") : t("segmentStart")} · {dayLabel(sec.entry_date)}
                </div>
                {sec.items.map((item) => {
                  const key = `${sec.entry_date}:${item.id}`;
                  return (
                    <div key={item.id} className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-sm font-medium" dir="auto">
                        <span>{item.label}</span>
                        {savingKeys[key] && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {item.options.map((opt) => {
                          const active = selected[key] === opt.id;
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
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {totalItems > 0 && !loading && !failed && (
          <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
            <span
              className={cn("flex items-center gap-1 text-xs", allDone ? "text-status-ok" : "text-muted-foreground")}
              dir="auto"
            >
              {allDone && <Check className="h-3.5 w-3.5" />}
              {allDone ? t("checkinAllSaved") : t("checkinAutosaveHint", { answered: answeredCount, total: totalItems })}
            </span>
            <Button size="sm" onClick={onClose}>{t("checkinDone")}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
