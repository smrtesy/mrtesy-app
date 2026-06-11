"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClipboardList, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";
import { formatDateOnly } from "@/lib/date";

interface ProposalRow {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
  due_date: string | null;
  duration_days: number | null;
  plan_title_he: string | null;
  plan_title_en: string | null;
  stage_name_he?: string | null;
  stage_name_en?: string | null;
}

/**
 * Plan assignments proposed TO the current user — surfaced at the top of the
 * suggestions inbox. Accepting routes the task into the regular flow
 * (waiting/desk by date); declining notifies the plan's manager.
 */
export function PlanProposals({ locale, onChanged }: { locale: string; onChanged?: () => void }) {
  const t = useTranslations("planProposals");
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchProposals = useCallback(async () => {
    try {
      const { tasks } = await api<{ tasks: ProposalRow[] }>("/api/plan/proposals");
      setProposals(tasks ?? []);
    } catch {
      // smrtPlan not enabled for this org — section simply stays empty.
      setProposals([]);
    }
  }, []);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  async function respond(taskId: string, accept: boolean) {
    setBusyId(taskId);
    try {
      await api(`/api/plan-tasks/${taskId}/assignment-response`, {
        method: "POST",
        body: { accept },
      });
      toast.success(accept ? t("accepted") : t("declined"));
      fetchProposals();
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (proposals.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("sectionTitle")} ({proposals.length})
      </h3>
      <div className="space-y-3">
        {proposals.map((p) => {
          const title = locale === "he" && p.title_he ? p.title_he : p.title;
          const planLabel = [
            locale === "en" ? p.plan_title_en || p.plan_title_he : p.plan_title_he || p.plan_title_en,
            locale === "en" ? p.stage_name_en || p.stage_name_he : p.stage_name_he || p.stage_name_en,
          ].filter(Boolean).join(" / ");
          return (
            <Card key={p.id} className="border-primary/30">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 rounded-full bg-primary/10 p-2">
                    <ClipboardList className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-medium" dir="auto">
                      {t("proposedPrefix")}: {title}
                    </h4>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {planLabel && (
                        <span className="rounded bg-accent px-2 py-0.5 text-accent-foreground">{planLabel}</span>
                      )}
                      {p.duration_days != null && <span>{t("duration", { days: p.duration_days })}</span>}
                      {p.due_date && <span>{t("due", { date: formatDateOnly(p.due_date, locale) })}</span>}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2" dir="auto">{p.description}</p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-9 gap-1 text-status-late hover:bg-status-late-bg"
                    onClick={() => respond(p.id, false)}
                    disabled={busyId === p.id}
                  >
                    <X className="h-4 w-4" />
                    {t("decline")}
                  </Button>
                  <Button
                    size="sm"
                    className="h-9 gap-1"
                    onClick={() => respond(p.id, true)}
                    disabled={busyId === p.id}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {t("accept")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
