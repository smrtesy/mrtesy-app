"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Archive, Clock, Check, BookOpenCheck } from "lucide-react";
import { sittingWorkdays, type BlockedDays } from "@/lib/workdays";
import type { Task } from "@/types/task";

/**
 * The periodic review — the waiting list's drain mechanism. Tasks untouched
 * for 20+ working days surface here in one batch: keep (resets the clock),
 * snooze, or archive — without hunting them one by one in the list.
 */
export function ReviewBanner({
  candidates,
  locale,
  blocked,
  onChanged,
  onSnooze,
}: {
  candidates: Task[];
  locale: string;
  blocked: BlockedDays;
  onChanged: () => void;
  onSnooze: (taskId: string) => void;
}) {
  const t = useTranslations("tasks.review");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (candidates.length === 0) return null;

  async function keep(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/seen`, { method: "POST" });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Archive via PATCH, NOT /complete: a stale recurring task archived as
  // "no longer relevant" must not spawn its next instance, and it shouldn't
  // get a completed_at as if it were done.
  async function archive(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { status: "archived" } });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function archiveAll() {
    if (!window.confirm(t("archiveAllConfirm", { count: candidates.length }))) return;
    setBusy(true);
    try {
      for (const task of candidates) {
        await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "archived" } });
      }
      toast.success(t("archivedAll"));
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn hover:bg-status-warn-bg/70 transition-colors"
      >
        <BookOpenCheck className="h-4 w-4 shrink-0" />
        <span dir="auto">{t("banner", { count: candidates.length })}</span>
      </button>

      <Dialog open={open} onOpenChange={(o) => !o && !busy && setOpen(false)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-start">{t("dialogTitle", { count: candidates.length })}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground" dir="auto">{t("dialogHint")}</p>

          <div className="space-y-2">
            {candidates.map((task) => {
              const title = locale === "he" && task.title_he ? task.title_he : task.title;
              const days = sittingWorkdays(task, blocked);
              return (
                <div key={task.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" dir="auto">{title}</p>
                    <p className="text-[11px] text-muted-foreground">{t("sittingFor", { days })}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1 text-status-ok"
                    title={t("keep")}
                    onClick={() => keep(task.id)}
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t("keep")}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1"
                    title={t("snooze")}
                    onClick={() => { setOpen(false); onSnooze(task.id); }}
                  >
                    <Clock className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1 text-muted-foreground"
                    title={t("archive")}
                    onClick={() => archive(task.id)}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("close")}
            </Button>
            <Button variant="outline" className="gap-1 text-status-late" onClick={archiveAll} disabled={busy}>
              <Archive className="h-4 w-4" />
              {t("archiveAll")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
