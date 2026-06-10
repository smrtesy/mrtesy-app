"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { dueUrgency, type BlockedDays, type DueUrgency } from "@/lib/workdays";

const urgencyClasses: Record<DueUrgency, string> = {
  overdue: "bg-status-late-bg text-status-late",
  today: "bg-status-late-bg text-status-late",
  soon: "bg-status-warn-bg text-status-warn",
  far: "bg-status-ok-bg text-status-ok",
};

/**
 * The due-date label: colored by working-day urgency, click-to-edit.
 *
 * - Shows the task's EFFECTIVE deadline (caller passes it — the earlier of
 *   due_date and the plan engine's latest_finish).
 * - No date → a quiet gray chip that invites adding one.
 * - `locked` (plan tasks — only the plan manager may move dates) → display
 *   only, no editor.
 * - `constrained` → the plan engine pulled the deadline earlier than the
 *   task's own due date; marked with ⚠.
 */
export function DueDateChip({
  deadline,
  locale,
  blocked,
  locked,
  constrained,
  onChange,
  className,
}: {
  deadline: string | null;
  locale: string;
  blocked: BlockedDays;
  locked?: boolean;
  constrained?: boolean;
  onChange?: (date: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("tasks.dueChip");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const urgency = deadline ? dueUrgency(deadline, blocked) : null;
  const editable = !!onChange && !locked;

  const label = deadline
    ? formatDateOnly(deadline, locale, { day: "numeric", month: "short" })
    : t("noDate");

  function open(e: React.MouseEvent) {
    e.stopPropagation();
    if (!editable) return;
    setDraft(deadline ?? "");
    setEditing(true);
  }

  function commit(value: string | null) {
    setEditing(false);
    onChange?.(value);
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!editable}
        title={locked ? t("lockedHint") : editable ? t("editHint") : undefined}
        className={cn(
          "shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold",
          urgency ? urgencyClasses[urgency] : "bg-secondary text-muted-foreground",
          editable && "cursor-pointer hover:ring-1 hover:ring-border",
          !editable && "cursor-default",
          className,
        )}
      >
        {urgency === "overdue" && <span className="me-0.5">!</span>}
        {label}
        {constrained && (
          <span className="ms-1 text-status-late" title={t("constrainedHint")}>⚠</span>
        )}
      </button>

      <Dialog open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        <DialogContent className="sm:max-w-xs" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="text-start">{t("dialogTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            type="date"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            dir="ltr"
            autoFocus
          />
          <DialogFooter className="gap-2">
            {deadline && (
              <Button variant="ghost" className="text-status-late" onClick={() => commit(null)}>
                {t("clear")}
              </Button>
            )}
            <Button onClick={() => commit(draft || null)} disabled={!draft && !deadline}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
