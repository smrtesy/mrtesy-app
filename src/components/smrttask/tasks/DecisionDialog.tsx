"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Captures the outcome of a decision task at completion time (docs
 * project-planning-protocol §10). The stated sentence is fanned out to every
 * task that lists this one in affected_by. Confirming with empty text still
 * completes the task — it just skips the propagation.
 */
export function DecisionDialog({
  open,
  taskTitle,
  onClose,
  onConfirm,
}: {
  open: boolean;
  taskTitle: string;
  /** Cancel — the task is NOT completed. */
  onClose: () => void;
  /** Complete the task, propagating `decision` (trimmed; may be empty). */
  onConfirm: (decision: string) => void;
}) {
  const t = useTranslations("tasks.decision");
  const [text, setText] = useState("");

  useEffect(() => { if (open) setText(""); }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-start">{t("title")}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground" dir="auto">{t("hint")}</p>
        {taskTitle && <p className="truncate text-sm font-medium" dir="auto">{taskTitle}</p>}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          dir="auto"
          placeholder={t("placeholder")}
          autoFocus
        />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={() => onConfirm(text.trim())}>{t("confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
