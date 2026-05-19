"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CASCADING_CODES = new Set(["sender_unimportant", "spam"]);

// Keep in sync with DISMISSAL_CODES in server/src/modules/smrttask/tasks/routes.ts
const REASONS = [
  { code: "not_relevant_work",  labelKey: "reasonNotRelevant"      },
  { code: "sender_unimportant", labelKey: "reasonSenderUnimportant" },
  { code: "topic_irrelevant",   labelKey: "reasonTopicIrrelevant"  },
  { code: "manual_handle",      labelKey: "reasonManualHandle"     },
  { code: "spam",               labelKey: "reasonSpam"             },
  { code: "ai_wrong",           labelKey: "reasonAiWrong"          },
  { code: "custom",             labelKey: "reasonCustom"           },
] as const;

interface DismissDialogProps {
  taskId: string | null;
  taskTitle?: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful dismissal so the parent can refresh */
  onDismissed: () => void;
}

export function DismissDialog({ taskId, taskTitle, open, onClose, onDismissed }: DismissDialogProps) {
  const t = useTranslations("suggestions");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Cascade preview — populated when user picks a cascading reason
  const [preview, setPreview] = useState<{ count: number; trigger: string | null } | null>(null);
  const [cascade, setCascade] = useState(true);

  // Fetch the cascade preview when the user picks a reason that propagates
  // (sender_unimportant / spam). Non-cascading reasons clear the preview.
  useEffect(() => {
    if (!taskId || !selectedCode || !CASCADING_CODES.has(selectedCode)) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api<{ cascade_count: number; cascade_trigger: string | null }>(
      `/api/tasks/${taskId}/dismiss-preview?reason_code=${selectedCode}`,
    )
      .then((data) => { if (!cancelled) setPreview({ count: data.cascade_count, trigger: data.cascade_trigger }); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [taskId, selectedCode]);

  function reset() {
    setSelectedCode(null);
    setCustomText("");
    setSubmitting(false);
    setPreview(null);
    setCascade(true);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!taskId || !selectedCode) return;
    if (selectedCode === "custom" && !customText.trim()) return;

    setSubmitting(true);
    try {
      const { rule_created, cascaded_count } = await api<{
        rule_created: { rule_type: string; trigger: string } | null;
        cascaded_count: number;
      }>(`/api/tasks/${taskId}/dismiss`, {
        method: "POST",
        body: {
          reason_code: selectedCode,
          reason_text: customText.trim() || undefined,
          cascade,
        },
      });

      // Toast hierarchy: most specific message wins.
      // If we cascaded > 0 also tell the user how many others closed.
      if (cascaded_count > 0) {
        toast.success(t("cascadedToast", { count: cascaded_count + 1 }));
      } else if (rule_created) {
        toast.success(t("ruleCreatedToast", { trigger: rule_created.trigger }));
      } else {
        toast.success(t("dismiss"));
      }
      reset();
      onDismissed();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setSubmitting(false);
    }
  }

  const submitDisabled =
    submitting ||
    !selectedCode ||
    (selectedCode === "custom" && !customText.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-start">{t("dismissDialogTitle")}</DialogTitle>
        </DialogHeader>

        {taskTitle && (
          <p className="text-sm text-muted-foreground line-clamp-2" dir="auto">
            {taskTitle}
          </p>
        )}

        <div className="space-y-1.5 mt-2">
          {REASONS.map((r) => (
            <button
              key={r.code}
              type="button"
              onClick={() => setSelectedCode(r.code)}
              className={cn(
                "w-full text-start rounded-md border px-3 py-2 text-sm transition-colors",
                "min-h-[44px]",  // mobile tap target
                selectedCode === r.code
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-input hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {t(r.labelKey as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>

        {selectedCode === "custom" && (
          <Textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={t("reasonCustomPlaceholder")}
            className="min-h-[80px] mt-2"
            dir="auto"
            autoFocus
          />
        )}

        {/* Cascade preview — only when the chosen reason propagates AND there
            are other pending suggestions from the same sender. */}
        {preview && preview.count > 0 && (
          <label className="flex items-start gap-2 mt-2 rounded-md border bg-muted/30 px-3 py-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex-1" dir="auto">
              {t("cascadeNote", { count: preview.count, trigger: preview.trigger ?? "" })}
            </span>
          </label>
        )}

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1 min-h-[44px]"
            onClick={handleClose}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            className="flex-1 min-h-[44px]"
            onClick={handleSubmit}
            disabled={submitDisabled}
          >
            {submitting ? t("dismissing") : t("dismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
