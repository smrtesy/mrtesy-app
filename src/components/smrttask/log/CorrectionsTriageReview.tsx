"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Gavel, Check, X } from "lucide-react";

/** Mirrors the server's PromptClass. Only "prompt" can reach the classifier. */
type PromptClass =
  | "prompt"
  | "code"
  | "ui"
  | "filter"
  | "covered"
  | "duplicate"
  | "needs_question"
  | "unclear";

interface GoldenCheck {
  checked: number;
  clean: boolean;
  summary_he: string;
  conflicts?: { subject: string; expected: string; would_be: string; why: string }[];
}

interface TriageBlock {
  reason_he?: string | null;
  /** What the triage understood the correction to want — shown so a misread is
   *  caught before acting. */
  understood_he?: string | null;
  /** For prompt_class="needs_question": the question awaiting an answer. */
  question_he?: string | null;
  suggested_rule_he?: string | null;
  /** For a prompt rule: how it measured against the golden set (plan slice 2). */
  golden_check?: GoldenCheck | null;
  approved?: boolean;
  decided_at?: string | null;
}

interface Correction {
  id: string;
  created_at: string;
  note: string;
  scope: string;
  context?: { prompt_class?: PromptClass; triage?: TriageBlock } | null;
}

/**
 * Review the triage verdicts waiting on a decision.
 *
 * This is the half that makes the triage mechanism usable at all: triage
 * classifies a correction and proposes the exact rule, but nothing reaches the
 * classifier until it is approved here. Built after a review pointed out the
 * endpoint had no caller — the verdicts were piling up with no way to accept
 * one, so the classifier could never learn anything new again.
 *
 * Collapsed by default per the repo's compact-UI rule: a quiet icon button that
 * only shows a count when something is actually waiting.
 */
export function CorrectionsTriageReview({ refreshKey }: { refreshKey: number }) {
  const t = useTranslations("corrections");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Correction[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { corrections } = await api<{ corrections: Correction[] }>("/api/corrections?limit=200");
      setRows(corrections ?? []);
    } catch {
      // non-fatal: the badge just stays as-is
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Waiting = triaged but not yet decided. An untriaged row is not actionable
  // yet (the sweep will get to it), and a decided one is done.
  const pending = useMemo(
    () =>
      rows.filter((c) => {
        const tri = c.context?.triage;
        return !!tri && tri.approved !== true && !tri.decided_at;
      }),
    [rows],
  );

  const decide = useCallback(
    async (c: Correction, decision: "approve" | "reject") => {
      setBusyId(c.id);
      try {
        // A PLAIN OBJECT, not JSON.stringify: api() stringifies opts.body itself
        // (lib/api/client.ts). Passing a pre-encoded string double-encodes it to
        // a top-level JSON string, which express.json() rejects with
        // entity.parse.failed — so every approve and reject 400'd. Both sibling
        // components here pass an object; reading one of them would have caught it.
        await api(`/api/corrections/${c.id}/decision`, {
          method: "POST",
          body: {
            decision,
            // Only send a rule when approving one — the server keeps the
            // suggestion otherwise.
            ...(decision === "approve" && edited[c.id]?.trim()
              ? { rule: edited[c.id].trim() }
              : {}),
          },
        });
        toast.success(decision === "approve" ? t("triageApproved") : t("triageRejected"));
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [edited, load, t],
  );

  // Quiet when there is nothing to decide — no permanent chrome.
  if (pending.length === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        onClick={() => setOpen(true)}
        title={t("triageReviewOpen")}
      >
        <Gavel className="h-3.5 w-3.5" />
        <span className="text-xs">{pending.length}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("triageReviewTitle")}</DialogTitle>
            <DialogDescription>{t("triageReviewDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {pending.map((c) => {
              const cls = c.context?.prompt_class ?? "unclear";
              const tri = c.context?.triage ?? {};
              const isRule = cls === "prompt";
              return (
                <div key={c.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm" dir="auto">{c.note}</p>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {t(`triageClass_${cls}`)}
                    </span>
                  </div>
                  {tri.understood_he && (
                    <p className="text-xs text-muted-foreground" dir="auto">
                      {t("triageUnderstood", { text: tri.understood_he })}
                    </p>
                  )}
                  {tri.reason_he && (
                    <p className="text-xs text-muted-foreground" dir="auto">{tri.reason_he}</p>
                  )}
                  {cls === "needs_question" && tri.question_he && (
                    <p className="text-xs font-medium" dir="auto">❓ {tri.question_he}</p>
                  )}
                  {isRule && (
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t("triageRuleLabel")}
                      </p>
                      <Textarea
                        rows={2}
                        dir="auto"
                        value={edited[c.id] ?? tri.suggested_rule_he ?? ""}
                        onChange={(e) => setEdited((p) => ({ ...p, [c.id]: e.target.value }))}
                      />
                      {tri.golden_check && tri.golden_check.checked > 0 && (
                        <p
                          className={`text-[11px] ${tri.golden_check.clean ? "text-muted-foreground" : "text-amber-600 dark:text-amber-500"}`}
                          dir="auto"
                        >
                          {tri.golden_check.summary_he}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === c.id}
                      onClick={() => decide(c, "reject")}
                    >
                      <X className="me-1 h-3.5 w-3.5" />
                      {t("triageReject")}
                    </Button>
                    <Button size="sm" disabled={busyId === c.id} onClick={() => decide(c, "approve")}>
                      <Check className="me-1 h-3.5 w-3.5" />
                      {isRule ? t("triageApproveRule") : t("triageApproveClass")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
