"use client";

/**
 * Review and approve a split (plan §4, decision §8.2).
 *
 * The proposal is a suggestion; nothing moves until the user approves here. For each
 * topic the model found, the user sees which turns it wants to move and the EXACT
 * handover text the new chat will receive — editable, because the promise ("this is
 * all the new chat gets") is only honest if what they read is what ships.
 *
 * Method per topic, default 'summary' (start clean): the child gets the handover
 * only. 'fork' (take everything): the child inherits the whole parent conversation.
 * The choice is stated in words, not jargon, because it changes what the child knows.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Scissors } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

export interface ProposedTopic {
  title: string;
  turn_indexes: number[];
  handover: string;
  reason: string;
}

interface Draft extends ProposedTopic {
  selected: boolean;
  method: "summary" | "fork";
}

export function SplitReview({
  threadId,
  analysisId,
  topics,
  open,
  onClose,
  onDone,
}: {
  threadId: string;
  analysisId: string | null;
  topics: ProposedTopic[];
  open: boolean;
  onClose: () => void;
  /** Called after the split is applied, with the created children. */
  onDone: (children: { id: string; title: string }[]) => void;
}) {
  const t = useTranslations("claudeChat.split");
  const [drafts, setDrafts] = useState<Draft[]>(
    // Everything selected by default — the common case is "yes, split these" — but
    // each is a checkbox the user can clear.
    topics.map((tp) => ({ ...tp, selected: true, method: "summary" })),
  );
  const [saving, setSaving] = useState(false);

  const chosen = drafts.filter((d) => d.selected);

  async function apply() {
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      const { children } = await api<{ children: { id: string; title: string }[] }>(
        `/api/claude/threads/${threadId}/split`,
        {
          method: "POST",
          body: {
            analysis_id: analysisId ?? undefined,
            selections: chosen.map((d) => ({
              title: d.title,
              turn_indexes: d.turn_indexes,
              handover: d.handover,
              method: d.method,
            })),
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
            <Scissors className="size-4" />
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
                  className="mt-1 size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" dir="auto">
                      {d.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t("turns", { count: d.turn_indexes.length })}
                    </span>
                  </div>
                  {d.reason && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground" dir="auto">
                      {d.reason}
                    </p>
                  )}
                </div>
              </label>

              {d.selected && (
                <div className="mt-2 space-y-2 ps-6">
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                      {t("handoverLabel")}
                    </p>
                    {/* Editable: what the user reads here is exactly what the new
                        chat receives — the promise is only true if they can see and
                        change it. */}
                    <Textarea
                      value={d.handover}
                      onChange={(e) => patch(i, { handover: e.target.value })}
                      rows={4}
                      dir="auto"
                      className="text-xs"
                      disabled={d.method === "fork"}
                      placeholder={t("handoverPlaceholder")}
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <MethodChip
                      active={d.method === "summary"}
                      label={t("methodSummary")}
                      onClick={() => patch(i, { method: "summary" })}
                    />
                    <MethodChip
                      active={d.method === "fork"}
                      label={t("methodFork")}
                      onClick={() => patch(i, { method: "fork" })}
                    />
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {d.method === "fork" ? t("methodForkHint") : t("methodSummaryHint")}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <p className="me-auto text-[11px] text-muted-foreground">
            {t("willKeep")}
          </p>
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

function MethodChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] transition",
        active
          ? "border-primary bg-primary font-semibold text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-secondary",
      )}
    >
      {label}
    </button>
  );
}
