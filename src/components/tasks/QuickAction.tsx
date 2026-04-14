"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save, Mail, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

interface QuickActionProps {
  taskId: string;
  actionLabel: string;
  actionPrompt: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function QuickAction({
  taskId,
  actionLabel,
  actionPrompt,
  open,
  onClose,
  onDone,
}: QuickActionProps) {
  const t = useTranslations("tasks.actions");
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [saving, setSaving] = useState(false);

  async function runAction() {
    setLoading(true);
    setResult("");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/quick-action`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            action_label: actionLabel,
            prompt: actionPrompt,
          }),
        }
      );

      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setResult(data.result || "");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    // Result is already saved in ai_generated_content by the Edge Function
    toast.success("Saved!");
    setSaving(false);
    onDone();
    onClose();
  }

  async function handleGmailDraft() {
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/create-gmail-draft`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: "", // User should fill in the To field
            subject: actionLabel,
            body: result,
            task_id: taskId,
          }),
        }
      );

      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      toast.success("Gmail draft created!");
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

  // Auto-run on open
  if (open && !loading && !result) {
    runAction();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="h-[70vh] sm:h-auto sm:max-h-[60vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start">{actionLabel}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-auto py-4">
          {loading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              <p className="text-sm text-muted-foreground">Claude is processing...</p>
            </div>
          )}

          {result && (
            <Textarea
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className="min-h-[200px] text-sm"
              dir="auto"
            />
          )}
        </div>

        {result && (
          <div className="sticky bottom-0 flex gap-2 border-t bg-background pt-3 pb-[env(safe-area-inset-bottom)]">
            <Button onClick={handleSave} disabled={saving} className="flex-1 min-h-[48px] gap-1">
              <Save className="h-4 w-4" />
              {t("saveDraft")}
            </Button>
            <Button onClick={handleGmailDraft} disabled={saving} variant="outline" className="flex-1 min-h-[48px] gap-1">
              <Mail className="h-4 w-4" />
              {t("gmailDraft")}
            </Button>
            <Button onClick={onClose} variant="ghost" size="icon" className="min-h-[48px] min-w-[48px]">
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
