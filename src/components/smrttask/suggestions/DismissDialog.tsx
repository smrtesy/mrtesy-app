"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Codes whose preview comes from the sender-only /dismiss-preview endpoint.
// sender_type_unimportant has its own narrower preview that arrives bundled
// with the AI-proposed subject keyword from /narrow-dismiss-propose.
const SENDER_PREVIEW_CODES = new Set(["sender_unimportant", "spam"]);

// Keep in sync with DISMISSAL_CODES in server/src/modules/smrttask/tasks/routes.ts
const REASONS = [
  { code: "sender_unimportant",      labelKey: "reasonSenderUnimportant"      },
  { code: "sender_type_unimportant", labelKey: "reasonSenderTypeUnimportant"  },
  { code: "spam",                    labelKey: "reasonSpam"                   },
  { code: "custom",                  labelKey: "reasonCustom"                 },
] as const;

interface DismissDialogProps {
  taskId: string | null;
  taskTitle?: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful dismissal so the parent can refresh */
  onDismissed: () => void;
  /** sender_type_unimportant is gmail-only — the parent should pass the
   *  task's source_type so we can hide / disable the option for WhatsApp
   *  and Calendar tasks instead of letting the user pick it and fail. */
  sourceType?: string | null;
}

export function DismissDialog({ taskId, taskTitle, open, onClose, onDismissed, sourceType }: DismissDialogProps) {
  const t = useTranslations("suggestions");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<{ count: number; trigger: string | null } | null>(null);
  const [cascade, setCascade] = useState(true);
  // Narrow-dismiss state: AI-proposed (and user-editable) subject keyword
  // for the "from this sender, only this type" flow. proposing=true while
  // the propose endpoint is in flight so the input renders as a spinner.
  const [proposing, setProposing] = useState(false);
  const [subjectKeyword, setSubjectKeyword] = useState("");

  const isEmailTask = sourceType === "gmail" || sourceType === "gmail_sent";

  useEffect(() => {
    if (!taskId || !selectedCode) {
      setPreview(null);
      return;
    }

    // Sender-only preview (sender_unimportant / spam) — existing endpoint.
    if (SENDER_PREVIEW_CODES.has(selectedCode)) {
      let cancelled = false;
      api<{ cascade_count: number; cascade_trigger: string | null }>(
        `/api/tasks/${taskId}/dismiss-preview?reason_code=${selectedCode}`,
      )
        .then((data) => { if (!cancelled) setPreview({ count: data.cascade_count, trigger: data.cascade_trigger }); })
        .catch(() => { if (!cancelled) setPreview(null); });
      return () => { cancelled = true; };
    }

    // Narrow preview (sender_type_unimportant) — propose endpoint that
    // returns BOTH the AI-suggested keyword AND the cascade preview
    // counted with the (sender + keyword) filter. We pre-fill the
    // keyword input from the AI's proposal; the user can edit before
    // submitting.
    if (selectedCode === "sender_type_unimportant") {
      let cancelled = false;
      setProposing(true);
      setSubjectKeyword("");
      api<{ subject_keyword: string; composed_trigger: string; cascade_count: number; has_proposal: boolean }>(
        `/api/tasks/${taskId}/narrow-dismiss-propose`,
      )
        .then((data) => {
          if (cancelled) return;
          setSubjectKeyword(data.subject_keyword ?? "");
          setPreview({ count: data.cascade_count, trigger: data.composed_trigger ?? null });
        })
        .catch(() => {
          if (!cancelled) {
            setSubjectKeyword("");
            setPreview(null);
          }
        })
        .finally(() => { if (!cancelled) setProposing(false); });
      return () => { cancelled = true; };
    }

    // Other codes (custom): no preview.
    setPreview(null);
  }, [taskId, selectedCode]);

  function reset() {
    setSelectedCode(null);
    setCustomText("");
    setSubmitting(false);
    setPreview(null);
    setCascade(true);
    setSubjectKeyword("");
    setProposing(false);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!taskId || !selectedCode) return;
    if (selectedCode === "custom" && !customText.trim()) return;
    if (selectedCode === "sender_type_unimportant" && !subjectKeyword.trim()) return;

    setSubmitting(true);
    try {
      const { rule_created, rule_pending, cascaded_count } = await api<{
        rule_created: { rule_type: string; trigger: string } | null;
        rule_pending: { rule_type: string; trigger: string; suggestion_confidence: number } | null;
        cascaded_count: number;
      }>(`/api/tasks/${taskId}/dismiss`, {
        method: "POST",
        body: {
          reason_code: selectedCode,
          reason_text: customText.trim() || undefined,
          cascade,
          subject_keyword: selectedCode === "sender_type_unimportant"
            ? subjectKeyword.trim()
            : undefined,
        },
      });

      // Toast hierarchy: most specific message wins.
      if (cascaded_count > 0) {
        toast.success(t("cascadedToast", { count: cascaded_count + 1 }));
      } else if (rule_created) {
        toast.success(t("ruleCreatedToast", { trigger: rule_created.trigger }));
      } else if (rule_pending) {
        toast.success(t("ruleProposedToast", { trigger: rule_pending.trigger }));
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
    (selectedCode === "custom" && !customText.trim()) ||
    (selectedCode === "sender_type_unimportant" && !subjectKeyword.trim());

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
          {REASONS.map((r) => {
            // Hide "sender_type_unimportant" for non-email tasks — there's
            // no subject field to match against. Server enforces the same
            // gate (POST /dismiss returns 400 for non-gmail sources).
            const disabled = r.code === "sender_type_unimportant" && !isEmailTask;
            return (
              <button
                key={r.code}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setSelectedCode(r.code)}
                className={cn(
                  "w-full text-start rounded-md border px-3 py-2 text-sm transition-colors",
                  "min-h-[44px]",
                  disabled
                    ? "border-input opacity-50 cursor-not-allowed"
                    : selectedCode === r.code
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <div>{t(r.labelKey as Parameters<typeof t>[0])}</div>
                {disabled && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t("reasonSenderTypeOnlyEmail")}
                  </div>
                )}
              </button>
            );
          })}
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

        {selectedCode === "sender_type_unimportant" && (
          <div className="mt-3 space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {t("reasonSenderTypePropose")}
            </p>
            <Input
              value={subjectKeyword}
              onChange={(e) => setSubjectKeyword(e.target.value)}
              placeholder={proposing ? "…" : t("reasonSenderTypeKeywordPlaceholder")}
              dir="auto"
              disabled={proposing}
              autoFocus
            />
            {!proposing && !subjectKeyword.trim() && (
              <p className="text-[11px] text-amber-600">
                {t("reasonSenderTypeKeywordRequired")}
              </p>
            )}
          </div>
        )}

        {/* Cascade preview — only when the chosen reason propagates AND there
            are other pending suggestions matching the rule's full scope. */}
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
