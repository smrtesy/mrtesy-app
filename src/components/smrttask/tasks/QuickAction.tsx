"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOpenWhatsAppChat } from "@/hooks/useOpenWhatsAppChat";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save, Mail, MessageCircle, Brain, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { translateActionLabel } from "@/lib/actionLabels";
import { toast } from "sonner";

interface QuickActionProps {
  taskId: string;
  actionLabel: string;
  actionPrompt?: string;
  sourceType?: string | null;
  contactPhone?: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function QuickAction({
  taskId,
  actionLabel,
  actionPrompt,
  sourceType,
  contactPhone,
  open,
  onClose,
  onDone,
}: QuickActionProps) {
  const t = useTranslations("tasks.actions");
  const tCommon = useTranslations("common");
  const { locale } = useParams<{ locale: string }>();
  const openWhatsApp = useOpenWhatsAppChat();

  // WhatsApp-sourced tasks (or WhatsApp draft actions) open the draft inside
  // the built-in WhatsApp chat for editing & sending, instead of a Gmail draft.
  const isWhatsapp =
    sourceType === "whatsapp" || actionLabel.startsWith("draft_whatsapp");
  const isDraft = actionLabel.startsWith("draft_");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingKb, setSavingKb] = useState(false);
  const hasRun = useRef(false);

  // Auto-run when sheet opens — properly in useEffect
  useEffect(() => {
    if (open && !hasRun.current) {
      hasRun.current = true;
      runAction();
    }
    if (!open) {
      // Reset state when closed
      hasRun.current = false;
      setResult("");
      setLoading(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runAction() {
    setLoading(true);
    setResult("");

    try {
      const data = await api<{ result?: string }>("/api/actions/execute", {
        method: "POST",
        body: {
          task_id: taskId,
          action_type: actionLabel,
          // Pass the LLM instruction so custom/AI-suggested labels (which
          // aren't in the fixed switch) can execute as a free-form prompt.
          custom_action: actionPrompt || actionLabel,
        },
      });
      setResult(data.result || "");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Read current ai_generated_content, patch last entry, write back
      const { task } = await api<{ task: { ai_generated_content: Array<Record<string, unknown>> | null } }>(`/api/tasks/${taskId}`);
      const content = task.ai_generated_content ?? [];
      if (content.length > 0) {
        content[content.length - 1].result = result;
      }
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { ai_generated_content: content },
      });

      toast.success(t("saveDraft"));
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveToKnowledge() {
    setSavingKb(true);
    try {
      const res = await api<{ status?: string }>("/api/knowledge/save", {
        method: "POST",
        body: { task_id: taskId, answer: result },
      });
      toast.success(res.status === "pending" ? t("savedToKnowledgePending") : t("savedToKnowledge"));
    } catch (e) {
      const msg = (e as Error).message;
      toast.error(msg.includes("embedding_unavailable") ? t("knowledgeUnavailable") : msg);
    } finally {
      setSavingKb(false);
    }
  }

  function handleOpenInWhatsapp() {
    if (!contactPhone) {
      toast.error(t("noWhatsappContact"));
      return;
    }
    onDone();
    onClose();
    // Open the conversation in the docked side-panel with the generated draft
    // prefilled — the task list stays in place. Inside a workspace pane (where
    // the docked panel is CSS-hidden) the hook routes to the full /whatsapp
    // reader instead; the draft can't ride the URL there, but that beats the
    // panel silently doing nothing.
    openWhatsApp(contactPhone, { draft: result });
  }

  async function handleGmailDraft() {
    setSaving(true);
    try {
      const data = await api<{ draft_url?: string }>("/api/actions/execute", {
        method: "POST",
        body: {
          task_id: taskId,
          // Use the action's own label when it's an email-draft action; otherwise
          // fall back to Hebrew reply draft (the most common case).
          action_type: actionLabel.startsWith("draft_reply_") || actionLabel.startsWith("draft_settlement")
            ? actionLabel
            : "draft_reply_he",
        },
      });

      toast.success(t("gmailDraft"));
      if (data.draft_url) {
        window.open(data.draft_url, "_blank");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      onDone();
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" dir={locale === "he" ? "rtl" : "ltr"} className="h-[70vh] sm:h-auto sm:max-h-[60vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start" dir="auto">{translateActionLabel(actionLabel, t)}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-auto py-4">
          {loading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t("quickAction")}...</p>
            </div>
          )}

          {!loading && result && (
            <Textarea
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className="min-h-[200px] text-sm"
              dir="auto"
            />
          )}
        </div>

        {result && !loading && (
          <div className="sticky bottom-0 flex gap-2 border-t bg-background pt-3 pb-[env(safe-area-inset-bottom)]">
            <Button onClick={handleSave} disabled={saving} className="flex-1 min-h-[48px] gap-1">
              <Save className="h-4 w-4" />
              {t("saveDraft")}
            </Button>
            {isWhatsapp ? (
              <Button onClick={handleOpenInWhatsapp} disabled={saving} variant="outline" className="flex-1 min-h-[48px] gap-1">
                <MessageCircle className="h-4 w-4" />
                {t("openInWhatsapp")}
              </Button>
            ) : (
              <Button onClick={handleGmailDraft} disabled={saving} variant="outline" className="flex-1 min-h-[48px] gap-1">
                <Mail className="h-4 w-4" />
                {t("gmailDraft")}
              </Button>
            )}
            {isDraft && (
              <IconButton
                label={t("saveToKnowledge")}
                color="violet"
                onClick={handleSaveToKnowledge}
                disabled={savingKb}
                className="min-h-[48px] min-w-[48px]"
              >
                {savingKb ? <Loader2 className="animate-spin" /> : <Brain />}
              </IconButton>
            )}
            <IconButton label={tCommon("close")} color="neutral" onClick={onClose} className="min-h-[48px] min-w-[48px]">
              <X />
            </IconButton>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
