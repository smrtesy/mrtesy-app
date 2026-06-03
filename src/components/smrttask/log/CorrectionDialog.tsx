"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Globe, User } from "lucide-react";

export type CorrectionScope = "general" | "personal";

/** The pre-filled context for a correction, assembled by the log row. */
export interface CorrectionDraft {
  source_message_id: string | null;
  task_id: string | null;
  log_entry_id: string | null;
  correction_type: "reclassify" | "status" | "note" | "other";
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  /** Comprehensive snapshot of the source/log row for a self-contained export. */
  context: Record<string, unknown>;
}

interface CorrectionDialogProps {
  open: boolean;
  draft: CorrectionDraft | null;
  onClose: () => void;
  /** Called after a correction is saved so the parent can refresh counts. */
  onSaved: () => void;
}

export function CorrectionDialog({ open, draft, onClose, onSaved }: CorrectionDialogProps) {
  const t = useTranslations("corrections");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<CorrectionScope>("personal");
  const [submitting, setSubmitting] = useState(false);

  // Reset the form whenever the dialog opens for a (possibly different) entry.
  // Keyed on the source_message_id rather than the draft object so an unrelated
  // parent re-render mid-edit can never wipe the user's typed note.
  useEffect(() => {
    if (open) {
      setNote("");
      setScope("personal");
      setSubmitting(false);
    }
  }, [open, draft?.source_message_id]);

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  async function handleSubmit() {
    if (!draft || !note.trim()) return;
    setSubmitting(true);
    try {
      await api("/api/corrections", {
        method: "POST",
        body: {
          source_message_id: draft.source_message_id,
          task_id: draft.task_id,
          log_entry_id: draft.log_entry_id,
          correction_type: draft.correction_type,
          field: draft.field,
          old_value: draft.old_value,
          new_value: draft.new_value,
          note: note.trim(),
          scope,
          context: draft.context,
        },
      });
      toast.success(t("saved"));
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  const hasChange = !!draft && (draft.old_value != null || draft.new_value != null);

  const scopeOptions: { value: CorrectionScope; icon: typeof Globe; titleKey: string; descKey: string }[] = [
    { value: "personal", icon: User, titleKey: "scopePersonal", descKey: "scopePersonalDesc" },
    { value: "general", icon: Globe, titleKey: "scopeGeneral", descKey: "scopeGeneralDesc" },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* What changed (when this correction accompanies a reclassify) */}
          {hasChange && (
            <div className="rounded-md border bg-muted/40 p-2.5 text-xs">
              <span className="text-muted-foreground">{t("changeLabel")}: </span>
              <span className="font-medium" dir="ltr">{draft?.old_value ?? "—"}</span>
              <span className="mx-1 text-muted-foreground">→</span>
              <span className="font-medium text-primary" dir="ltr">{draft?.new_value ?? "—"}</span>
            </div>
          )}

          {/* Scope picker */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t("scopeLabel")}</p>
            <div className="grid grid-cols-2 gap-2">
              {scopeOptions.map((opt) => {
                const Icon = opt.icon;
                const active = scope === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setScope(opt.value)}
                    className={cn(
                      "rounded-lg border p-2.5 text-start transition-colors",
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className={cn("h-3.5 w-3.5", active ? "text-primary" : "text-muted-foreground")} />
                      <span className={cn("text-xs font-medium", active && "text-primary")}>
                        {t(opt.titleKey)}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-tight text-muted-foreground">{t(opt.descKey)}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Explanation */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("noteLabel")}</p>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              rows={4}
              dir="auto"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !note.trim()}>
            {submitting ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
