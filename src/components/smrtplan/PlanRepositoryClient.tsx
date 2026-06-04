"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Lightbulb } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
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

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { plans } = await api<{ plans: Plan[] }>("/api/plans/repository");
        if (alive) setPlans(plans ?? []);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
                  {p.goal && <p className="mt-1 text-[12.5px] text-muted-foreground">{p.goal}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
