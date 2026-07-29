"use client";

/**
 * Review and approve a forward DECOMPOSITION.
 *
 * Different from SplitReview: nothing is moved. The plan chat keeps all its turns;
 * each approved part becomes a NEW child chat that starts with the briefing shown
 * here (its seed_context). The briefing is editable, because what the user reads is
 * exactly what the child begins knowing.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Split } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

export interface ProposedPart {
  title: string;
  scope: string;
}

interface Draft extends ProposedPart {
  selected: boolean;
}

export function DecomposeReview({
  threadId,
  analysisId,
  parts,
  open,
  onClose,
  onDone,
}: {
  threadId: string;
  analysisId: string | null;
  parts: ProposedPart[];
  open: boolean;
  onClose: () => void;
  /** Called after the decomposition is applied, with the created children. */
  onDone: (children: { id: string; title: string }[]) => void;
}) {
  const t = useTranslations("claudeChat.decompose");
  const [drafts, setDrafts] = useState<Draft[]>(parts.map((p) => ({ ...p, selected: true })));
  const [saving, setSaving] = useState(false);

  const chosen = drafts.filter((d) => d.selected && d.title.trim());

  async function apply() {
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      const { children } = await api<{ children: { id: string; title: string }[] }>(
        `/api/claude/threads/${threadId}/decompose`,
        {
          method: "POST",
          body: {
            analysis_id: analysisId ?? undefined,
            parts: chosen.map((d) => ({ title: d.title, scope: d.scope })),
          },
        },
      );
      toast.success(t("done", { count: children.length }));
      onDone(children);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function patch(i: number, next: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...next } : d)));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Split className="size-4" />
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{t("intro")}</p>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-1">
          {drafts.map((d, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg border p-3 transition",
                d.selected ? "border-primary/40 bg-primary/5" : "opacity-60",
              )}
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={d.selected}
                  onChange={(e) => patch(i, { selected: e.target.checked })}
                  className="mt-2 size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <Input
                    value={d.title}
                    onChange={(e) => patch(i, { title: e.target.value })}
                    dir="auto"
                    className="h-8 text-sm font-semibold"
                    placeholder={t("titlePlaceholder")}
                  />
                </div>
              </label>

              {d.selected && (
                <div className="mt-2 space-y-1 ps-6">
                  <p className="text-[11px] font-medium text-muted-foreground">{t("scopeLabel")}</p>
                  <Textarea
                    value={d.scope}
                    onChange={(e) => patch(i, { scope: e.target.value })}
                    rows={4}
                    dir="auto"
                    className="text-xs"
                    placeholder={t("scopePlaceholder")}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <p className="me-auto text-[11px] text-muted-foreground">{t("willKeep")}</p>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={apply} disabled={saving || chosen.length === 0}>
            {saving && <Loader2 className="me-1 size-4 animate-spin" />}
            {t("apply", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
