"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lightbulb, Settings2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PlanEditDialog } from "@/components/smrtplan/PlanEditDialog";
import type { Plan, PlanStage } from "@/types/plan";

const stageClasses: Record<PlanStage, string> = {
  idea: "bg-secondary text-muted-foreground",
  shaping: "bg-status-warn-bg text-status-warn",
  active: "bg-status-ok-bg text-status-ok",
};

export function PlanRepositoryClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  // The plan whose settings dialog is open. A repository card had no way to open
  // anything, so a plan with no start_date was stranded here — this is the way in.
  const [editing, setEditing] = useState<Plan | null>(null);
  // Only a planner (full access) may edit or promote — the same gate the board
  // applies. Without it, a lite member gets buttons that 403 (and a Delete).
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ access_level: string }>("/api/plans/access")
      .then((d) => { if (alive) setCanEdit(d.access_level === "full"); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const { plans } = await api<{ plans: Plan[] }>("/api/plans/repository");
      setPlans(plans ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Put a repository plan on the timeline: a start_date is exactly what moves it
   *  from here to the board. Opens the settings dialog right after, since the
   *  date, minutes, workdays and performer are all set in one place there.
   *
   *  "Today" is resolved in New York, not in the browser's/container's zone — a
   *  plan started at 20:00 EDT must not be dated tomorrow. en-CA gives YYYY-MM-DD. */
  async function promote(p: Plan) {
    const iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    // The plan leaves this screen for the board, and closing the dialog does not
    // undo it — so confirm first rather than moving it on a stray click.
    if (!confirm(t("repository.promoteConfirm", { date: iso }))) return;
    try {
      await api(`/api/plans/${p.id}`, { method: "PATCH", body: { start_date: iso } });
      toast.success(t("repository.promoted"));
      setEditing({ ...p, start_date: iso });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  const title = (p: Plan) => (locale === "en" ? p.title_en || p.title_he : p.title_he);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t("repository.title")}</h1>
        <p className="text-[12.5px] text-muted-foreground">{t("repository.lead")}</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("repository.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {plans.map((p) => (
            <div key={p.id} className="rounded-lg border bg-card p-3.5 transition-colors hover:bg-accent/40">
              <div className="flex items-start gap-3">
                <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-bold">{title(p)}</span>
                    <span
                      className={cn(
                        "rounded px-2 py-px text-[10px] font-bold",
                        stageClasses[p.stage] ?? stageClasses.idea,
                      )}
                    >
                      {t(`repository.stage.${p.stage}`)}
                    </span>
                    <span className="rounded bg-accent px-1.5 py-px text-[10px] font-medium text-accent-foreground">
                      {t(`kind.${p.kind}`)}
                    </span>
                  </div>
                  {(() => { const g = locale === "en" ? p.goal_en || p.goal : p.goal; return g ? <p className="mt-1 text-[12.5px] text-muted-foreground">{g}</p> : null; })()}
                </div>
                {/* Quiet icon + one action, per the compact-UI rule: settings for
                    configuring in place, promote for putting it on the board. */}
                {canEdit && (
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(p)}
                      title={t("edit.editPlan")} aria-label={t("edit.editPlan")}>
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-[11.5px]" onClick={() => promote(p)}>
                      {t("repository.promote")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <PlanEditDialog
        plan={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </div>
  );
}
