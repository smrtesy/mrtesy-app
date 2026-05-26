"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api/client";

interface Settings {
  monthly_budget_usd: number;
  budget_warning_threshold: number;
}

interface Project {
  total_cost_usd: number | null;
  created_at: string;
}

export function BudgetIndicator() {
  const t = useTranslations("smrtVoice.budget");
  const [data, setData] = useState<{ used: number; budget: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [{ settings }, { projects }] = await Promise.all([
          api<{ settings: Settings }>("/api/voice/settings"),
          api<{ projects: Project[] }>("/api/voice/projects"),
        ]);
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const used = projects
          .filter((p) => new Date(p.created_at) >= monthStart)
          .reduce((sum, p) => sum + (p.total_cost_usd ?? 0), 0);
        if (mounted) {
          setData({ used, budget: settings.monthly_budget_usd });
        }
      } catch {
        // silently ignore — header widget shouldn't error out
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!data) return null;
  const pct = data.budget > 0 ? Math.min(100, (data.used / data.budget) * 100) : 0;

  return (
    <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t("label")}</span>
      <span className="font-medium">
        ${data.used.toFixed(2)} / ${data.budget.toFixed(0)}
      </span>
      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
